/**
 * 推送通道抽象（审计 F2）。
 *
 * 说明书的两个触发点：
 *   3.1-2 想念值下降 → 召回用户
 *   3.2-2 异步 3D 生成完成 → 通知用户，让等待不必干等
 *
 * 现在只有本地实现（记录到内存 + 日志），配置了 FCM / 极光 / Server 酱
 * 之类就能切到真实通道。**不做假推送**：未接入时接口返回
 * `delivered: false, reason: 'not-configured'`，前端不会假装收到通知。
 */

export type PushChannel = 'web-push' | 'apns' | 'fcm' | 'wechat' | 'local';

export interface PushMessage {
  userId: string;
  title: string;
  body: string;
  /** 点击后跳转的页内路径，如 /hut 或 /cabin */
  url?: string;
  /** 归类，便于用户按类型关掉 */
  category: 'longing' | 'generation' | 'streak' | 'foster' | 'system';
  /** 同一 tag 的通知会互相覆盖，避免堆一屏 */
  tag?: string;
}

export interface PushResult {
  delivered: boolean;
  channel: PushChannel;
  /** 未投递时的原因，前端与运维都要能看懂 */
  reason?: 'not-configured' | 'no-subscription' | 'rate-limited' | 'failed';
  detail?: string;
}

export interface PushProvider {
  readonly channel: PushChannel;
  readonly configured: boolean;
  send(message: PushMessage): Promise<PushResult>;
}

/* ------------------------------------------------------------------ */
/* 本地实现：记录但不投递                                              */
/* ------------------------------------------------------------------ */

/**
 * 本地通道：把通知记进内存环形缓冲，供「我的 → 通知」列表展示。
 *
 * 这不是真正的推送（App 不在前台就收不到），但对单机部署很实用：
 * 用户在应用内能看到「它想你了」这类提醒，且导出/排查都方便。
 */
export class LocalPushProvider implements PushProvider {
  readonly channel: PushChannel = 'local';
  readonly configured = true;
  private readonly recent: (PushMessage & { at: string })[] = [];
  private readonly maxKeep = 200;

  async send(message: PushMessage): Promise<PushResult> {
    this.recent.push({ ...message, at: new Date().toISOString() });
    if (this.recent.length > this.maxKeep) this.recent.splice(0, this.recent.length - this.maxKeep);
    return { delivered: true, channel: 'local', detail: '已记录到应用内通知列表' };
  }

  list(userId: string, limit = 20) {
    return this.recent.filter((m) => m.userId === userId).slice(-limit).reverse();
  }

  clear(): void {
    this.recent.length = 0;
  }
}

/* ------------------------------------------------------------------ */
/* 真实通道占位：未配置时明确回 not-configured                          */
/* ------------------------------------------------------------------ */

/**
 * Web Push（浏览器推送）。
 *
 * 需要 VAPID 密钥对与前端 ServiceWorker 订阅。
 * 国内浏览器支持不一致（微信内置浏览器完全不支持），所以它是
 * 「能用则用」而不是主通道 —— 主通道在 App 内通知列表。
 */
export class WebPushProvider implements PushProvider {
  readonly channel: PushChannel = 'web-push';
  readonly configured: boolean;

  private readonly options: { publicKey: string; privateKey: string; sendEndpoint: string };

  constructor(options: { publicKey: string; privateKey: string; sendEndpoint: string }) {
    this.options = options;
    this.configured = Boolean(options.publicKey && options.privateKey && options.sendEndpoint);
  }

  async send(message: PushMessage): Promise<PushResult> {
    if (!this.configured) {
      return {
        delivered: false,
        channel: this.channel,
        reason: 'not-configured',
        detail: '缺少 VAPID 公钥/私钥或投递端点，见 docs/API-INTEGRATION.md 第 9 节',
      };
    }
    try {
      const res = await fetch(this.options.sendEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(message),
      });
      if (!res.ok) {
        return { delivered: false, channel: this.channel, reason: 'failed', detail: `HTTP ${res.status}` };
      }
      return { delivered: true, channel: this.channel };
    } catch (error) {
      return { delivered: false, channel: this.channel, reason: 'failed', detail: String(error).slice(0, 120) };
    }
  }
}

/* ------------------------------------------------------------------ */
/* 对外接口                                                            */
/* ------------------------------------------------------------------ */

export class PushService {
  readonly local = new LocalPushProvider();
  private provider: PushProvider;

  constructor(extra?: PushProvider) {
    // 配了真实通道就用它，否则用本地（本地始终可用，保证功能不缺失）
    this.provider = extra?.configured ? extra : this.local;
  }

  get activeChannel(): PushChannel {
    return this.provider.channel;
  }

  get realChannelConfigured(): boolean {
    return this.provider.channel !== 'local';
  }

  /**
   * 发送通知。永远不会抛异常 —— 通知失败不该影响主流程
   * （例如生成完成的通知发不出去，宠物还是要正常交付）。
   */
  async send(message: PushMessage): Promise<PushResult> {
    try {
      const result = await this.provider.send(message);
      // 真实通道失败时也记一份到本地，保证用户至少能在应用内看到
      if (!result.delivered) await this.local.send(message);
      return result;
    } catch (error) {
      await this.local.send(message);
      return { delivered: false, channel: this.provider.channel, reason: 'failed', detail: String(error).slice(0, 120) };
    }
  }
}

/* ------------------------------------------------------------------ */
/* 通知文案                                                            */
/* ------------------------------------------------------------------ */

/**
 * 想念值召回的文案。
 * 刻意不做「你已 3 天没登录」这种考勤式提醒 ——
 * 说明书 3.1-2 要求的是「宠物表达小情绪」，而不是平台催用户。
 */
export function longingPushText(petName: string, longing: number): { title: string; body: string } {
  if (longing < 25) {
    return { title: `${petName}在窗边坐了很久`, body: '它没说什么，只是把你的拖鞋挪到了门口。' };
  }
  if (longing < 50) {
    return { title: `${petName}想你了`, body: '「你上次走的时候没关灯。」' };
  }
  return { title: `${petName}今天很安静`, body: '「我数了一下，你今天还没来。」' };
}

export function generationDonePushText(petName: string, degraded: boolean): { title: string; body: string } {
  return degraded
    ? { title: `${petName}先出来了`, body: '3D 服务暂时不可用，先用本地形象陪你。' }
    : { title: `${petName}准备好了`, body: '它试着动了一下爪子，进去打个招呼吧。' };
}
