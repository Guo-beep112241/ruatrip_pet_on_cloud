import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { Brain, Mic, Send, ShieldAlert, Volume2, Wand2 } from 'lucide-react';
import { AppShell } from '../components/AppShell';
import { Card, Chip, EmptyState, Sheet } from '../components/ui';
import { useApp } from '../store/app';
import { goTo } from '../hooks/useHashRouter';

const QUICK_LINES = [
  '今天有点累',
  '你在干什么呀',
  '我想带你去旅行',
  '你还记得上次说的吗',
];

/** 屏2：真心话小屋 —— 文字/语音对话、记忆回看、人格档案展示 */
export function TruthHut() {
  const pet = useApp((s) => s.pet);
  const messages = useApp((s) => s.messages);
  const thinking = useApp((s) => s.thinking);
  const loadChat = useApp((s) => s.loadChat);
  const sendChat = useApp((s) => s.sendChat);
  const speak = useApp((s) => s.speak);
  const memories = useApp((s) => s.memories);
  const integration = useApp((s) => s.integration);
  const pushToast = useApp((s) => s.pushToast);

  const [text, setText] = useState('');
  const [recording, setRecording] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<{ start: () => void; stop: () => void; abort: () => void } | null>(null);

  useEffect(() => {
    void loadChat();
  }, [loadChat, pet?.id]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages.length, thinking]);

  const chatLive = integration.some((i) => i.category === 'chat' && i.configured && i.provider !== 'mock');
  const supportFlagged = messages.some(
    (m) => m.role === 'pet' && (m.content.includes('去找一个真人') || m.content.includes('我在这儿，我什么都不问')),
  );

  if (!pet) {
    return (
      <AppShell title="真心话小屋" subtitle="还没有可以说话的宠物">
        <EmptyState
          emoji="🚪"
          title="小屋还空着"
          description="先去孵化一只宠物，它会在这里等你说第一句话。"
          action={
            <button type="button" className="rt-button mt-snug" onClick={() => goTo('onboarding')}>
              去孵化
            </button>
          }
        />
      </AppShell>
    );
  }

  const submit = async (value: string) => {
    const content = value.trim();
    if (!content) return;
    setText('');
    await sendChat(content);
  };

  /** 按住说话：优先浏览器 SpeechRecognition（零成本），失败则提示配置服务端 ASR */
  const startVoice = () => {
    const Ctor =
      (window as unknown as { SpeechRecognition?: new () => never; webkitSpeechRecognition?: new () => never })
        .SpeechRecognition ??
      (window as unknown as { webkitSpeechRecognition?: new () => never }).webkitSpeechRecognition;

    if (!Ctor) {
      const asrConfigured = integration.some((i) => i.category === 'asr' && i.configured);
      pushToast(
        asrConfigured
          ? '当前浏览器不支持语音识别，请用文字输入。'
          : '浏览器语音识别不可用：需要接入服务端 ASR（见「我的 → 能力接入」）。',
        'plain',
        '🎙️',
      );
      return;
    }

    const recognition = new (Ctor as unknown as new () => {
      lang: string;
      interimResults: boolean;
      continuous: boolean;
      onresult: (e: { results: { 0: { 0: { transcript: string } } } }) => void;
      onerror: () => void;
      onend: () => void;
      start: () => void;
      stop: () => void;
      abort: () => void;
    })();
    recognition.lang = 'zh-CN';
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.onresult = (event) => {
      const transcript = event.results[0]?.[0]?.transcript ?? '';
      setText(transcript);
    };
    recognition.onerror = () => setRecording(false);
    recognition.onend = () => setRecording(false);
    recognitionRef.current = recognition;
    recognition.start();
    setRecording(true);
  };

  const stopVoice = () => {
    recognitionRef.current?.stop();
    setRecording(false);
    if (text.trim()) void submit(text);
  };

  return (
    <AppShell
      title="真心话小屋"
      subtitle="这里更暗一些，因为它更私密。它不是通用聊天机器人，是你养的这只在跟你说话。"
      atmosphere={2}
      accessory={
        <div className="flex items-center gap-2">
          <button type="button" className="rt-button-quiet rt-tap-target" onClick={() => setProfileOpen(true)}>
            人格档案卡
          </button>
          <button type="button" className="rt-button-quiet rt-tap-target" onClick={() => setMemoryOpen(true)}>
            <Brain size={14} aria-hidden />
            记忆 {memories.length}
          </button>
        </div>
      }
    >
      <div className="grid gap-comfortable lg:grid-cols-[minmax(0,1fr)_280px]">
        <Card padded={false} className="flex h-[62dvh] min-h-[420px] flex-col overflow-hidden">
          <div className="flex items-center justify-between gap-snug border-b border-border-subtle/40 px-base py-snug">
            <div className="flex items-center gap-2">
              <span className="text-xl" aria-hidden>
                💬
              </span>
              <div>
                <p className="text-body-sm font-bold text-text-primary">{pet.name}</p>
                <p className="text-caption-sm text-text-muted">
                  {pet.personality.traits.join(' / ')} · {pet.personality.voiceProfile}
                </p>
              </div>
            </div>
            <Chip active={chatLive}>{chatLive ? '自由层：真实模型' : '自由层：本地人格模板'}</Chip>
          </div>

          <div ref={listRef} className="flex-1 space-y-snug overflow-y-auto px-base py-base">
            {messages.map((m) => (
              <div
                key={m.id}
                className={clsx('flex gap-snug', m.role === 'user' ? 'justify-end' : 'justify-start')}
              >
                {m.role === 'pet' ? (
                  <span className="mt-1 text-lg leading-none" aria-hidden>
                    🐾
                  </span>
                ) : null}
                <div className={clsx('max-w-[80%]', m.role === 'user' ? 'items-end' : 'items-start')}>
                  <div
                    className={clsx(
                      'animate-drop-in rounded-card px-base py-snug text-body-sm leading-relaxed shadow-plush',
                      m.role === 'user'
                        ? 'rounded-br-sm bg-brand-primary/90 text-text-inverse'
                        : 'rounded-bl-sm bg-surface-raised text-text-primary',
                    )}
                  >
                    {m.content}
                  </div>
                  <div className="mt-1 flex items-center gap-2 pl-1">
                    <span className="text-caption-sm text-text-muted">
                      {LAYER_LABEL[m.layer] ?? m.layer}
                      {m.fromModel ? ' · 模型' : ''}
                    </span>
                    {m.role === 'pet' ? (
                      <button
                        type="button"
                        onClick={() => void speak(m.content)}
                        className="text-caption-sm text-text-muted underline-offset-2 transition-colors hover:text-brand-primary hover:underline"
                      >
                        <Volume2 size={11} className="mr-0.5 inline" aria-hidden />
                        听它说
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            ))}
            {thinking ? (
              <div className="flex items-center gap-2 pl-1 text-body-sm text-text-muted">
                <span className="animate-pulse-soft">{pet.name}正在想怎么回答……</span>
              </div>
            ) : null}
          </div>

          {supportFlagged ? (
            <div className="mx-4 mb-snug flex items-start gap-2 rounded-card bg-state-warning/18 px-base py-snug text-caption text-text-secondary">
              <ShieldAlert size={14} className="mt-0.5 shrink-0 text-state-warning" aria-hidden />
              <span>
                它只是一个陪伴形象，不能替代真实的人。如果你现在很沉，请联系可以触碰到你的人，或拨打心理援助热线 12356。
              </span>
            </div>
          ) : null}

          <div className="border-t border-border-subtle/40 bg-surface-raised/70 px-base py-snug">
            <div className="mb-snug flex gap-1.5 overflow-x-auto no-scrollbar">
              {QUICK_LINES.map((line) => (
                <button
                  key={line}
                  type="button"
                  className="rt-chip shrink-0 rt-tap-target transition-transform active:scale-95"
                  onClick={() => void submit(line)}
                >
                  {line}
                </button>
              ))}
            </div>
            <div className="flex items-end gap-snug">
              <input
                className="rt-input"
                placeholder={`跟${pet.name}说点什么……`}
                value={text}
                maxLength={200}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void submit(text);
                  }
                }}
              />
              <button
                type="button"
                className={clsx('rt-button-quiet rt-tap-target shrink-0', recording && 'bg-brand-primary text-text-inverse')}
                onMouseDown={startVoice}
                onMouseUp={stopVoice}
                onMouseLeave={() => recording && stopVoice()}
                onTouchStart={(e) => {
                  e.preventDefault();
                  startVoice();
                }}
                onTouchEnd={(e) => {
                  e.preventDefault();
                  stopVoice();
                }}
                aria-label="按住说话"
              >
                <Mic size={16} aria-hidden />
              </button>
              <button
                type="button"
                className="rt-button rt-tap-target shrink-0"
                onClick={() => void submit(text)}
                disabled={!text.trim()}
                aria-label="发送"
              >
                <Send size={16} aria-hidden />
              </button>
            </div>
            <p className="mt-1.5 text-caption-sm text-text-muted">
              按住麦克风说话。语音识别优先用浏览器能力，方言/口音场景可在「我的 → 能力接入」配服务端 ASR。
            </p>
          </div>
        </Card>

        {/* 右侧：能力分层与安全说明（桌面端） */}
        <div className="hidden flex-col gap-base lg:flex">
          <Card>
            <p className="rt-label">对话能力分层</p>
            <ul className="mt-snug space-y-2 text-caption text-text-secondary">
              <li><strong className="text-text-primary">即时层</strong> · 问候、喂食反馈、抚摸回应——本地预设池，零延迟</li>
              <li><strong className="text-text-primary">场景层</strong> · 结合时间、天气、打卡地点的回应</li>
              <li><strong className="text-text-primary">自由层</strong> · 你自由输入的内容，走大模型 + 人格卡提示词</li>
              <li><strong className="text-text-primary">记忆层</strong> · 引用历史对话与共同经历</li>
            </ul>
            <p className="mt-snug text-caption-sm text-text-muted">
              这样分层是为了成本：常用互动不上模型，只有自由对话才调用接口。
            </p>
          </Card>
          <Card>
            <p className="rt-label">内容安全</p>
            <ul className="mt-snug space-y-1.5 text-caption text-text-secondary">
              <li>· 前置过滤：自我认知类追问、医疗建议、成人内容、政治敏感</li>
              <li>· 后置审核：模型输出二次检查后才展示</li>
              <li>· 情绪关怀：识别到强烈负面情绪时，以它自己的方式关心，并提示现实支持渠道</li>
            </ul>
          </Card>
        </div>
      </div>

      <Sheet
        open={memoryOpen}
        onClose={() => setMemoryOpen(false)}
        title="它记得的事"
        description="每段对话结束后自动提炼摘要；关键事件会单独标记，它会在之后主动提起。"
      >
        <ul className="space-y-snug">
          {memories.map((m) => (
            <li key={m.id} className="rounded-card bg-surface-sunken/70 p-snug">
              <div className="flex items-center gap-2">
                <Chip active={m.kind === 'key-event'}>{m.kind === 'key-event' ? '关键事件' : '对话摘要'}</Chip>
                <span className="text-caption-sm text-text-muted">重要性 {m.importance}</span>
                <span className="text-caption-sm text-text-muted">
                  {new Date(m.createdAt).toLocaleDateString('zh-CN')}
                </span>
              </div>
              <p className="mt-1.5 text-body-sm text-text-secondary">{m.content}</p>
            </li>
          ))}
          {!memories.length ? (
            <li className="text-body-sm text-text-muted">还没有记忆。多聊几句，它就会开始记住你。</li>
          ) : null}
        </ul>
      </Sheet>

      <Sheet
        open={profileOpen}
        onClose={() => setProfileOpen(false)}
        title="性格档案卡"
        description="系统提示词由这张卡自动拼装，所以同一句输入，布偶猫和水豚的回答语气完全不同。"
      >
        <div className="space-y-snug text-body-sm">
          <Field label="物种与品种">{pet.personality.species}</Field>
          <Field label="性格标签">{pet.personality.traits.join(' / ')}</Field>
          <Field label="说话节奏">{pet.personality.speechRhythm}</Field>
          <Field label="口头禅">{pet.personality.catchphrases.map((c) => `「${c}」`).join(' ')}</Field>
          <Field label="喜好话题">{pet.personality.likes.join(' / ')}</Field>
          <Field label="回避话题">{pet.personality.dislikes.join(' / ')}</Field>
          <Field label="小毛病">{pet.quirks.join(' / ')}</Field>
          <Field label="音色预设">{pet.personality.voiceProfile}</Field>
          <Field label="记忆锚点">
            {pet.personality.memoryAnchors.length ? pet.personality.memoryAnchors.join('；') : '还没有共同经历'}
          </Field>
        </div>
        <div className="mt-base flex items-start gap-2 rounded-card bg-surface-sunken/70 p-snug text-caption text-text-muted">
          <Wand2 size={14} className="mt-0.5 shrink-0" aria-hidden />
          <span>这张卡由偏好问卷自动生成，不是手写的。宠物性格里的「缺点」是有意保留的——完美的宠物不好玩。</span>
        </div>
      </Sheet>
    </AppShell>
  );
}

const LAYER_LABEL: Record<string, string> = {
  instant: '即时层',
  scene: '场景层',
  free: '自由层',
  memory: '记忆层',
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-border-subtle/40 pb-1.5">
      <p className="rt-label">{label}</p>
      <p className="mt-0.5 text-text-secondary">{children}</p>
    </div>
  );
}
