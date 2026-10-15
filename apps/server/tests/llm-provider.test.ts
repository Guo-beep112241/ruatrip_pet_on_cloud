/**
 * 大模型适配层的集成测试。
 *
 * 做法：起一个本地 HTTP 服务冒充「OpenAI 兼容端点」，
 * 把 LLM_BASE_URL 指向它，再调用 completeChat()。
 * 这样不用花任何钱、不需要真 key，就能验证：
 *   1. 请求格式（Bearer 头、model 字段、system 合并进 messages）正确；
 *   2. 各家返回的 content 能被正确取出，reasoning_content 不会被误读给用户；
 *   3. 401 / 402 / 404 会翻译成用户看得懂的、可照做的提示；
 *   4. 任何失败都会回落 Mock，对话不会中断。
 *
 * 为什么能直接改 process.env：config.ts 用的是惰性 getter，每次访问都重读环境变量。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { activeLlmProvider, completeChat, getLastLlmError } from '../src/adapters/chat.ts';

interface FakeReply {
  status: number;
  body: unknown;
}

interface FakeLlm {
  baseUrl: string;
  calls: { headers: Record<string, string | string[] | undefined>; body: any }[];
  close: () => Promise<void>;
}

/** 起一个假模型端点，按队列返回预设响应，并记录收到的请求 */
async function startFakeLlm(replies: FakeReply[]): Promise<FakeLlm> {
  const calls: FakeLlm['calls'] = [];
  let index = 0;

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        parsed = null;
      }
      calls.push({ headers: req.headers, body: parsed });

      const reply = replies[Math.min(index, replies.length - 1)] as FakeReply;
      index += 1;
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** 把环境变量摆成「只配了通用国产模型通道」的样子 */
function useLlmChannel(baseUrl: string, model = 'deepseek-flash'): void {
  process.env.LLM_API_KEY = 'sk-test-key';
  process.env.LLM_BASE_URL = baseUrl;
  process.env.LLM_MODEL = model;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
  delete process.env.OPENAI_MODEL;
}

const OPENAI_STYLE_OK: FakeReply = {
  status: 200,
  body: {
    choices: [{ message: { content: '嗯……我在听。' } }],
    usage: { prompt_tokens: 120, completion_tokens: 12 },
  },
};

test('请求格式正确，且能取出国产模型返回的 content', async () => {
  const fake = await startFakeLlm([OPENAI_STYLE_OK]);
  try {
    useLlmChannel(fake.baseUrl);
    assert.equal(activeLlmProvider().meta.id, 'openai-compatible', '配了 LLM_* 就该选中通用通道');

    const res = await completeChat({
      system: '你是一只布偶猫，名字叫汤圆。',
      turns: [{ role: 'user', content: '今天有点累' }],
    });

    assert.equal(res.text, '嗯……我在听。');
    assert.equal(res.live, true, '必须走真实通道而不是 Mock');
    assert.equal(res.model, 'deepseek-flash');
    assert.equal(res.usage?.inputTokens, 120);

    const call = fake.calls[0]!;
    assert.match(String(call.headers.authorization), /^Bearer sk-test-key$/, '必须是 Bearer 认证');
    assert.equal(call.body.model, 'deepseek-flash');
    assert.equal(call.body.messages[0].role, 'system', 'system prompt 要作为第一条消息');
    assert.match(call.body.messages[0].content, /布偶猫/);
    assert.equal(call.body.messages[1].content, '今天有点累');
    assert.ok(Number.isFinite(call.body.max_tokens), '要传 max_tokens 控制成本');
  } finally {
    await fake.close();
  }
});

test('只取最终回答，丢弃 reasoning_content（避免把思考过程读给用户）', async () => {
  const fake = await startFakeLlm([
    {
      status: 200,
      body: {
        choices: [
          {
            message: {
              reasoning_content: '用户说累了，我应该先共情……（内部思考，不该给用户看）',
              content: '嗯……那你先坐下。',
            },
          },
        ],
      },
    },
  ]);
  try {
    useLlmChannel(fake.baseUrl, 'some-thinking-model');
    const res = await completeChat({ system: 's', turns: [{ role: 'user', content: '累' }] });
    assert.equal(res.text, '嗯……那你先坐下。');
    assert.ok(!res.text.includes('内部思考'), 'reasoning_content 不得出现在结果里');
  } finally {
    await fake.close();
  }
});

test('401 密钥无效 → 翻译成可操作提示，并回落 Mock', async () => {
  const fake = await startFakeLlm([{ status: 401, body: { error: { message: 'invalid api key' } } }]);
  try {
    useLlmChannel(fake.baseUrl);
    const res = await completeChat({ system: 's', turns: [{ role: 'user', content: '你好' }] });

    assert.equal(res.live, false, '失败后必须回落 Mock，对话不能中断');
    assert.ok(res.text.length > 0, 'Mock 必须给出可用回复');

    const err = getLastLlmError();
    assert.ok(err?.includes('LLM_AUTH_FAILED'), `错误应被翻译：${err}`);
    assert.ok(err?.includes('LLM_API_KEY'), '提示里要告诉用户改哪个变量');
  } finally {
    await fake.close();
  }
});

test('402 余额不足 → 明确提示去充值', async () => {
  const fake = await startFakeLlm([{ status: 402, body: { error: { message: 'Insufficient Balance' } } }]);
  try {
    useLlmChannel(fake.baseUrl);
    const res = await completeChat({ system: 's', turns: [{ role: 'user', content: '你好' }] });
    assert.equal(res.live, false);
    assert.ok(getLastLlmError()?.includes('LLM_NO_BALANCE'), getLastLlmError() ?? '');
  } finally {
    await fake.close();
  }
});

test('404 模型名或地址不对 → 提示检查 BASE_URL 与 MODEL', async () => {
  const fake = await startFakeLlm([{ status: 404, body: { error: { message: 'model not found' } } }]);
  try {
    useLlmChannel(fake.baseUrl, 'no-such-model');
    await completeChat({ system: 's', turns: [{ role: 'user', content: '你好' }] });
    assert.ok(getLastLlmError()?.includes('LLM_MODEL_NOT_FOUND'), getLastLlmError() ?? '');
  } finally {
    await fake.close();
  }
});

test('连不上端点 → 回落 Mock，不抛异常', async () => {
  // 指向一个没有服务在听的端口
  useLlmChannel('http://127.0.0.1:1/v1');
  const res = await completeChat({ system: 's', turns: [{ role: 'user', content: '你好' }] });
  assert.equal(res.live, false);
  assert.ok(res.text.length > 0);
  assert.ok(getLastLlmError(), '失败原因要被记录，供能力接入面板展示');
});

test('模型返回空内容 → 视为失败并回落 Mock', async () => {
  const fake = await startFakeLlm([{ status: 200, body: { choices: [{ message: { content: '   ' } }] } }]);
  try {
    useLlmChannel(fake.baseUrl);
    const res = await completeChat({ system: 's', turns: [{ role: 'user', content: '你好' }] });
    assert.equal(res.live, false, '空回复不能被当成成功，否则用户会看到空气泡');
    assert.ok(res.text.length > 0);
    assert.ok(getLastLlmError()?.includes('LLM_EMPTY_RESPONSE'), getLastLlmError() ?? '');
  } finally {
    await fake.close();
  }
});

test('没配任何 key → 直接用 Mock，且不发起网络请求', async () => {
  delete process.env.LLM_API_KEY;
  delete process.env.LLM_BASE_URL;
  delete process.env.LLM_MODEL;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
  delete process.env.OPENAI_MODEL;
  delete process.env.ANTHROPIC_API_KEY;

  assert.equal(activeLlmProvider().meta.id, 'mock');

  const res = await completeChat({ system: 's', turns: [{ role: 'user', content: '你好' }] });
  assert.equal(res.live, false);
  assert.equal(res.model, 'mock-persona-template');
  assert.ok(res.text.length > 0);
  assert.equal(getLastLlmError(), null, '没配 key 不算错误，不该显示红色告警');
});

test('改 .env 无需重启即可生效（惰性配置）', async () => {
  delete process.env.LLM_API_KEY;
  delete process.env.LLM_BASE_URL;
  delete process.env.ANTHROPIC_API_KEY;
  assert.equal(activeLlmProvider().meta.id, 'mock', '先回到 Mock');

  const fake = await startFakeLlm([OPENAI_STYLE_OK]);
  try {
    useLlmChannel(fake.baseUrl, 'glm-4-flash');
    assert.equal(activeLlmProvider().meta.id, 'openai-compatible', '设上环境变量后应立即切换');
    const res = await completeChat({ system: 's', turns: [{ role: 'user', content: '你好' }] });
    assert.equal(res.model, 'glm-4-flash');
  } finally {
    await fake.close();
  }
});
