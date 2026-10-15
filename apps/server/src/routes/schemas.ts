/**
 * 请求体校验规则（审计 M1 / M6）。
 *
 * 从 index.ts 抽出：所有写接口的入参规则集中一处，
 * 一眼能看全「哪些字段会被接受」。
 *
 * 关键语义：**未声明的字段会被丢弃** —— 这挡住了
 * 「客户端顺手塞 tier / ownerId 做权限提升」。
 */
import { validate, type Schema } from '../http/validate.ts';

export const SCHEMAS = {
  survey: {
    answers: { type: 'stringArray', label: '问卷答案', maxItems: 12, maxLength: 64 },
  },
  createPet: {
    name: { type: 'string', label: '名字', min: 1, max: 12, required: true },
    callName: { type: 'string', label: '昵称', max: 12 },
  },
  patchPet: {
    petId: { type: 'string', label: 'petId', max: 64, required: true },
    name: { type: 'string', label: '名字', min: 1, max: 12 },
    callName: { type: 'string', label: '昵称', max: 12 },
    outfitId: { type: 'nullableString', label: '服饰', max: 64 },
    sceneId: { type: 'string', label: '场景', max: 64 },
  },
  interact: {
    petId: { type: 'string', label: 'petId', max: 64, required: true },
    action: { type: 'enum', values: ['feed', 'bathe', 'play'] as const, label: '互动类型', required: true },
    toyId: { type: 'string', label: '玩具', max: 32 },
  },
  touchPet: {
    petId: { type: 'string', label: 'petId', max: 64, required: true },
    part: { type: 'enum', values: ['head', 'chin', 'tail'] as const, label: '部位' },
    gesture: { type: 'enum', values: ['tap', 'long', 'double'] as const, label: '手势' },
  },
  redeem: {
    petId: { type: 'string', label: 'petId', max: 64, required: true },
    itemId: { type: 'string', label: '兑换物', max: 64, required: true },
  },
  chat: {
    petId: { type: 'string', label: 'petId', max: 64, required: true },
    conversationId: { type: 'string', label: '会话', max: 64 },
    text: { type: 'string', label: '内容', min: 1, max: 500, required: true },
    layer: { type: 'enum', values: ['auto', 'instant', 'scene', 'free', 'memory'] as const, label: '分层' },
    viaVoice: { type: 'boolean', label: '语音输入' },
  },
  tts: {
    petId: { type: 'string', label: 'petId', max: 64, required: true },
    text: { type: 'string', label: '文本', min: 1, max: 300, required: true },
  },
  checkin: {
    petId: { type: 'string', label: 'petId', max: 64, required: true },
    destinationId: { type: 'string', label: '目的地', max: 48, required: true },
    photoUrl: { type: 'imageRef', label: '照片' },
    lat: { type: 'number', label: '纬度', min: -90, max: 90 },
    lng: { type: 'number', label: '经度', min: -180, max: 180 },
    note: { type: 'string', label: '备注', max: 200 },
  },
  journal: {
    petId: { type: 'string', label: 'petId', max: 64, required: true },
    checkinId: { type: 'string', label: '打卡记录', max: 64 },
    template: { type: 'enum', values: ['warm-paper', 'polaroid', 'magazine', 'minimal'] as const, label: '模板' },
    destinationName: { type: 'string', label: '目的地', max: 48 },
    extraNote: { type: 'string', label: '补充', max: 300 },
  },
  postcard: {
    petId: { type: 'string', label: 'petId', max: 64, required: true },
    checkinId: { type: 'string', label: '打卡记录', max: 64 },
    to: { type: 'string', label: '收件人', max: 32 },
    template: { type: 'enum', values: ['postcard-classic', 'instagram-grid', 'wechat-moments'] as const, label: '模板' },
  },
  capsule: {
    photoUrl: { type: 'imageRef', label: '旧照', required: true },
    petName: { type: 'string', label: '名字', min: 1, max: 24, required: true },
    letterTo: { type: 'string', label: '想说的话', max: 400 },
  },
  foster: {
    petId: { type: 'string', label: 'petId', max: 64, required: true },
    friendName: { type: 'string', label: '好友昵称', max: 24, required: true },
    days: { type: 'number', label: '天数', min: 1, max: 14, integer: true },
  },
  patchProfile: {
    nickname: { type: 'string', label: '昵称', min: 1, max: 24 },
    avatarEmoji: { type: 'string', label: '头像', max: 8 },
    minorGuardEnabled: { type: 'boolean', label: '未成年人保护' },
    monthlySpendLimit: { type: 'number', label: '月消费上限', min: 0, max: 5000 },
  },
  subscribe: {
    tier: { type: 'enum', values: ['free', 'plus', 'pro'] as const, label: '档位' },
    cycle: { type: 'enum', values: ['monthly', 'yearly'] as const, label: '周期' },
  },
  register: {
    email: { type: 'string', label: '邮箱', min: 5, max: 254, required: true },
    password: { type: 'string', label: '密码', min: 1, max: 200, required: true },
    nickname: { type: 'string', label: '昵称', max: 24 },
  },
  login: {
    email: { type: 'string', label: '邮箱', min: 1, max: 254, required: true },
    password: { type: 'string', label: '密码', min: 1, max: 200, required: true },
  },
  changePassword: {
    currentPassword: { type: 'string', label: '当前密码', max: 200 },
    newPassword: { type: 'string', label: '新密码', min: 1, max: 200, required: true },
  },
  deleteAccount: {
    password: { type: 'string', label: '密码', max: 200 },
    confirm: { type: 'string', label: '确认串', required: true, max: 16 },
  },
  petIdQuery: {
    petId: { type: 'string', label: 'petId', max: 64, required: true },
  },
} satisfies Record<string, Schema>;

/** 校验入口：统一抛出带 issues 的 400 */
export function check<S extends Schema>(input: unknown, schema: S): ReturnType<typeof validate<S>> {
  return validate(input, schema);
}
