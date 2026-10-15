/**
 * RuaTrip 静态内容目录（问卷 / 物种 / 目的地 / 商店 / 订阅）
 * 前后端共用，保证「同一份规则」。
 */
import type {
  Destination,
  PetMood,
  PreferenceQuestion,
  ShopItem,
  Species,
  SubscriptionPlan,
} from './index.ts';

/* ------------------------------------------------------------
 * 1. 偏好问卷（说明书 5.1：8-10 题，3 分钟内完成，有趣不枯燥）
 * ---------------------------------------------------------- */
export const PREFERENCE_QUESTIONS: PreferenceQuestion[] = [
  {
    id: 'species',
    question: '如果它能开口说话，你觉得会是哪种小动物？',
    helper: '不必是猫或狗，我们的物种库不设限',
    options: [
      { id: 'ragdoll', label: '布偶猫', value: 'ragdoll', emoji: '🐱', hint: '慵懒、粘人、偶尔毒舌' },
      { id: 'corgi', label: '柯基', value: 'corgi', emoji: '🐶', hint: '热情、贪吃、屁股很有想法' },
      { id: 'shiba', label: '柴犬', value: 'shiba', emoji: '🐕', hint: '傲娇、嘴硬心软' },
      { id: 'bunny', label: '垂耳兔', value: 'bunny', emoji: '🐰', hint: '安静、警觉、爱跺脚' },
      { id: 'fox', label: '小狐狸', value: 'fox', emoji: '🦊', hint: '机灵、有点狡黠' },
      { id: 'capybara', label: '水豚', value: 'capybara', emoji: '🦫', hint: '佛系、稳如泰山' },
      { id: 'alpaca', label: '羊驼', value: 'alpaca', emoji: '🦙', hint: '毛茸茸、慢半拍' },
      { id: 'chimera', label: '想象混合物种', value: 'chimera', emoji: '✨', hint: '由你描述，我们造一只新的' },
    ],
  },
  {
    id: 'bodySize',
    question: '你想要抱得住的，还是跟得上的？',
    helper: '决定体型比例与镜头距离',
    options: [
      { id: 'tiny', label: '能放进外套口袋', value: 'tiny', emoji: '🫧' },
      { id: 'small', label: '一只手抱得动', value: 'small', emoji: '🤲' },
      { id: 'medium', label: '可以搂着睡', value: 'medium', emoji: '🛋️' },
      { id: 'large', label: '跟得上我跑步', value: 'large', emoji: '🏃' },
    ],
  },
  {
    id: 'fur',
    question: '摸上去是蓬松的、顺滑的，还是短毛扎手？',
    helper: '决定材质球类型与毛发渲染强度',
    options: [
      { id: 'fluffy', label: '蓬松得像棉花糖', value: 'fluffy', emoji: '☁️' },
      { id: 'silky', label: '顺滑得像缎子', value: 'silky', emoji: '🎀' },
      { id: 'short', label: '短毛，有点扎手', value: 'short', emoji: '🌾' },
      { id: 'curly', label: '卷卷的，像小羊', value: 'curly', emoji: '🌀' },
    ],
  },
  {
    id: 'palette',
    question: '从色卡里挑三个你最喜欢的颜色',
    helper: '决定毛色主色与花纹掩码',
    maxSelect: 3,
    options: [
      { id: 'oat', label: '燕麦白', value: 'oat', emoji: '🥛' },
      { id: 'chestnut', label: '暖栗棕', value: 'chestnut', emoji: '🌰' },
      { id: 'coral', label: '珊瑚橘', value: 'coral', emoji: '🪸' },
      { id: 'cream', label: '奶黄', value: 'cream', emoji: '🧈' },
      { id: 'sage', label: '鼠尾草绿', value: 'sage', emoji: '🌿' },
      { id: 'slate', label: '雾霾灰', value: 'slate', emoji: '🩶' },
      { id: 'ink', label: '墨黑', value: 'ink', emoji: '🖤' },
      { id: 'plum', label: '梅子紫', value: 'plum', emoji: '🍇' },
    ],
  },
  {
    id: 'personality',
    question: '你希望它是什么性格？（可多选，最多两个）',
    helper: '决定动画权重、待机动作与对话人格卡',
    maxSelect: 2,
    options: [
      { id: 'clingy', label: '粘人的', value: 'clingy', emoji: '🫶' },
      { id: 'aloof', label: '高冷的', value: 'aloof', emoji: '🧊' },
      { id: 'chaotic', label: '疯疯的', value: 'chaotic', emoji: '🎉' },
      { id: 'mature', label: '老成的', value: 'mature', emoji: '📖' },
      { id: 'tsundere', label: '傲娇的', value: 'tsundere', emoji: '😼' },
      { id: 'shy', label: '胆小的', value: 'shy', emoji: '🫣' },
    ],
  },
  {
    id: 'rhythm',
    question: '你喜欢每天黏在一起，还是偶尔见面？',
    helper: '决定互动频率与留存提醒强度',
    options: [
      { id: 'clingy', label: '每天都要见', value: 'clingy', emoji: '🌞' },
      { id: 'balanced', label: '有空就来', value: 'balanced', emoji: '⛅' },
      { id: 'independent', label: '偶尔见一面就够', value: 'independent', emoji: '🌙' },
    ],
  },
  {
    id: 'travel',
    question: '下一次出发，你想带它去哪里？（可多选）',
    helper: '决定首推场景与首批徽章',
    maxSelect: 2,
    options: [
      { id: 'mountain', label: '山野', value: 'mountain', emoji: '⛰️' },
      { id: 'seaside', label: '海边', value: 'seaside', emoji: '🌊' },
      { id: 'city', label: '城市街区', value: 'city', emoji: '🏙️' },
      { id: 'foreign-alley', label: '异国小巷', value: 'foreign-alley', emoji: '🏮' },
      { id: 'snow', label: '雪夜', value: 'snow', emoji: '❄️' },
      { id: 'desert', label: '沙漠', value: 'desert', emoji: '🏜️' },
    ],
  },
  {
    id: 'photoHabit',
    question: '旅行时你会拍很多照片吗？',
    helper: '决定手账功能的引导强度',
    options: [
      { id: 'heavy', label: '拍到手机没电', value: 'heavy', emoji: '📸' },
      { id: 'normal', label: '会拍一些', value: 'normal', emoji: '🖼️' },
      { id: 'light', label: '很少拍', value: 'light', emoji: '👀' },
    ],
  },
];

/* ------------------------------------------------------------
 * 2. 物种库（说明书 5.2：物种不设限）
 * ---------------------------------------------------------- */
export const SPECIES_CATALOG: Species[] = [
  { id: 'ragdoll', name: '布偶猫', emoji: '🐱', family: 'feline', fallbackRig: 'quadruped' },
  { id: 'corgi', name: '柯基', emoji: '🐶', family: 'canine', fallbackRig: 'quadruped' },
  { id: 'shiba', name: '柴犬', emoji: '🐕', family: 'canine', fallbackRig: 'quadruped' },
  { id: 'bunny', name: '垂耳兔', emoji: '🐰', family: 'rodent', fallbackRig: 'quadruped' },
  { id: 'hamster', name: '仓鼠', emoji: '🐹', family: 'rodent', fallbackRig: 'quadruped' },
  { id: 'fox', name: '小狐狸', emoji: '🦊', family: 'canine', fallbackRig: 'quadruped' },
  { id: 'fawn', name: '小鹿', emoji: '🦌', family: 'cervid', fallbackRig: 'quadruped' },
  { id: 'capybara', name: '水豚', emoji: '🦫', family: 'rodent', fallbackRig: 'quadruped' },
  { id: 'alpaca', name: '羊驼', emoji: '🦙', family: 'cervid', fallbackRig: 'quadruped' },
  { id: 'bird', name: '小鸟', emoji: '🐦', family: 'avian', fallbackRig: 'avian' },
  { id: 'chimera', name: '混合想象物种', emoji: '✨', family: 'hybrid', fallbackRig: 'quadruped' },
];

/* ------------------------------------------------------------
 * 3. 情绪状态文案（驱动情绪气泡）
 * ---------------------------------------------------------- */
export const MOOD_COPY: Record<PetMood, { label: string; lines: string[]; emoji: string }> = {
  happy: { label: '满足', emoji: '😊', lines: ['嗯……今天也不错。', '你回来啦，我一直在窗边。'] },
  sleepy: { label: '困倦', emoji: '😴', lines: ['呼……再让我睡五分钟。', '你说话的声音好适合当摇篮曲。'] },
  hungry: { label: '饿了', emoji: '🍚', lines: ['我闻到饭的味道了，是不是给我的？', '碗是空的，你检查一下。'] },
  dirty: { label: '想洗澡', emoji: '🫧', lines: ['我身上有风的味道了。', '……你确定要闻我吗？'] },
  playful: { label: '想玩', emoji: '🎾', lines: ['那个小球！就是那个！', '陪我一下，就一下。'] },
  lonely: { label: '想你了', emoji: '🥺', lines: ['你上次走的时候没关灯。', '我数了三天，你都没来。'] },
  proud: { label: '得意', emoji: '😼', lines: ['本喵恩准你今天摸头。', '看，我今天很好看吧。'] },
  shy: { label: '害羞', emoji: '😳', lines: ['别、别一直看着我。', '……可以再摸一下。'] },
};

/* ------------------------------------------------------------
 * 4. 目的地 / 城市剧情副本（说明书 7.2-②⑧）
 * ---------------------------------------------------------- */
export const DESTINATIONS: Destination[] = [
  {
    id: 'chengdu',
    name: '成都',
    region: '四川',
    country: '中国',
    lat: 30.5728,
    lng: 104.0668,
    scene: 'city',
    storyTitle: '竹林里的一整个下午',
    storyChapters: [
      { index: 1, title: '第一碗茶', content: '它在竹椅上坐了一下午，尾巴跟着盖碗茶的节奏一晃一晃。' },
      { index: 2, title: '辣的边界', content: '它试图偷吃一口红油，然后整只猫变成了喷火龙。' },
      { index: 3, title: '慢下来', content: '它说：这里的人走路都不着急，我也学会了。' },
    ],
    exclusiveSkin: { id: 'skin-panda', name: '熊猫花色', emoji: '🐼' },
    souvenirPool: [
      { id: 's-chopstick', name: '小竹筷', emoji: '🥢', rarity: 'common' },
      { id: 's-panda', name: '熊猫发卡', emoji: '🎀', rarity: 'rare' },
      { id: 's-teacup', name: '盖碗茶', emoji: '🍵', rarity: 'epic' },
    ],
    emoji: '🐼',
  },
  {
    id: 'sanya',
    name: '三亚',
    region: '海南',
    country: '中国',
    lat: 18.2528,
    lng: 109.5119,
    scene: 'seaside',
    storyTitle: '第一次见到海',
    storyChapters: [
      { index: 1, title: '沙子的味道', content: '它尝了一口沙子，然后非常严肃地宣布：不好吃。' },
      { index: 2, title: '浪来了', content: '第一个浪打过来时它跳到了你肩膀上，装作什么都没发生。' },
      { index: 3, title: '黄昏', content: '它安静下来，说：这个颜色，我想记很久。' },
    ],
    exclusiveSkin: { id: 'skin-shell', name: '贝壳配饰', emoji: '🐚' },
    souvenirPool: [
      { id: 's-shell', name: '小海螺', emoji: '🐚', rarity: 'common' },
      { id: 's-star', name: '海星发饰', emoji: '⭐', rarity: 'rare' },
      { id: 's-pearl', name: '夜光珍珠', emoji: '🫧', rarity: 'epic' },
    ],
    emoji: '🌊',
  },
  {
    id: 'lijiang',
    name: '丽江',
    region: '云南',
    country: '中国',
    lat: 26.8721,
    lng: 100.2299,
    scene: 'mountain',
    storyTitle: '雪山下的慢邮局',
    storyChapters: [
      { index: 1, title: '石板路', content: '它的爪子在青石板上敲出很轻的鼓点。' },
      { index: 2, title: '寄一封信', content: '它在明信片上按了一个爪印，说这就是签名。' },
      { index: 3, title: '雪线', content: '它抬头看了很久，说：山比我想象的要有耐心。' },
    ],
    exclusiveSkin: { id: 'skin-cloud', name: '云肩披风', emoji: '☁️' },
    souvenirPool: [
      { id: 's-bell', name: '小铜铃', emoji: '🔔', rarity: 'common' },
      { id: 's-scarf', name: '纳西织巾', emoji: '🧣', rarity: 'rare' },
      { id: 's-lantern', name: '雪山灯', emoji: '🏮', rarity: 'epic' },
    ],
    emoji: '⛰️',
  },
  {
    id: 'tokyo',
    name: '东京',
    region: '关东',
    country: '日本',
    lat: 35.6762,
    lng: 139.6503,
    scene: 'foreign-alley',
    storyTitle: '巷子里的小食堂',
    storyChapters: [
      { index: 1, title: '自动贩卖机', content: '它盯着贩卖机看了三分钟，最后选了最便宜的那瓶。' },
      { index: 2, title: '深夜食堂', content: '老板给它留了一个小碟子，它觉得自己被这座城市接纳了。' },
      { index: 3, title: '雨', content: '它在便利店门口躲雨，说：这里的雨也很守规矩。' },
    ],
    exclusiveSkin: { id: 'skin-neon', name: '霓虹和服', emoji: '🏮' },
    souvenirPool: [
      { id: 's-omamori', name: '御守', emoji: '🎐', rarity: 'common' },
      { id: 's-cat', name: '招财猫', emoji: '🐈', rarity: 'rare' },
      { id: 's-fan', name: '金箔折扇', emoji: '🪭', rarity: 'epic' },
    ],
    emoji: '🏮',
  },
  {
    id: 'harbin',
    name: '哈尔滨',
    region: '黑龙江',
    country: '中国',
    lat: 45.8038,
    lng: 126.5349,
    scene: 'snow',
    storyTitle: '零下二十度的拥抱',
    storyChapters: [
      { index: 1, title: '第一场雪', content: '它在雪里打了个滚，然后变成了一颗糖霜团子。' },
      { index: 2, title: '冰雕', content: '它对着冰雕里的自己看了很久，说：那个家伙好冷。' },
      { index: 3, title: '回屋', content: '它把爪子贴在暖气上，说：人类真会想办法。' },
    ],
    exclusiveSkin: { id: 'skin-snow', name: '雪绒斗篷', emoji: '❄️' },
    souvenirPool: [
      { id: 's-glove', name: '小手套', emoji: '🧤', rarity: 'common' },
      { id: 's-ice', name: '冰晶挂坠', emoji: '💎', rarity: 'rare' },
      { id: 's-star2', name: '极光星灯', emoji: '🌟', rarity: 'epic' },
    ],
    emoji: '❄️',
  },
  {
    id: 'dunhuang',
    name: '敦煌',
    region: '甘肃',
    country: '中国',
    lat: 40.1421,
    lng: 94.6616,
    scene: 'desert',
    storyTitle: '沙漠里的一千零一夜',
    storyChapters: [
      { index: 1, title: '骆驼', content: '它和骆驼对视了十秒，双方都没有先眨眼。' },
      { index: 2, title: '沙丘', content: '它从沙丘上滑下来，重复了七次。' },
      { index: 3, title: '星空', content: '它说：原来天可以这么大，那我那点小心事就不算什么了。' },
    ],
    exclusiveSkin: { id: 'skin-silk', name: '飞天丝带', emoji: '🎗️' },
    souvenirPool: [
      { id: 's-sand', name: '流沙瓶', emoji: '⏳', rarity: 'common' },
      { id: 's-lute', name: '小琵琶', emoji: '🪕', rarity: 'rare' },
      { id: 's-mural', name: '壁画拓片', emoji: '🖼️', rarity: 'epic' },
    ],
    emoji: '🏜️',
  },
];

/* ------------------------------------------------------------
 * 5. 好感度商店（说明书 6.1 消耗方式 / 十一）
 * ---------------------------------------------------------- */
export const SHOP_ITEMS: ShopItem[] = [
  {
    id: 'outfit-scarf', kind: 'outfit', tier: 'starter', name: '手工毛线围巾',
    description: '第一件衣服，边角还有点歪，但很暖。', price: 60,
    affectionOnly: true, emoji: '🧣', previewColor: '#E8734A',
  },
  {
    id: 'outfit-raincoat', kind: 'outfit', tier: 'seasonal', name: '梅雨小黄雨衣',
    description: '雨天出门专用，踩水坑也不怕。', price: 140,
    affectionOnly: true, emoji: '🧥', previewColor: '#E9B949',
  },
  {
    id: 'outfit-kimono', kind: 'outfit', tier: 'limited', name: '秋日限定和服',
    description: '限定款，只在秋天开放兑换。', price: 320,
    affectionOnly: true, emoji: '👘', previewColor: '#B4544A', subscriberEarlyAccess: true,
  },
  {
    id: 'outfit-collab', kind: 'outfit', tier: 'collab', name: '城市联名斗篷',
    description: '与景区联名的限定斗篷，需要长期积累。', price: 620,
    affectionOnly: true, emoji: '🥻', previewColor: '#6E8B6A', subscriberEarlyAccess: true,
  },
  {
    id: 'scene-snownight', kind: 'scene', tier: 'seasonal', name: '雪夜',
    description: '窗外下雪，屋里有暖气。', price: 200,
    affectionOnly: true, emoji: '❄️', previewColor: '#9FB4C7',
  },
  {
    id: 'scene-study', kind: 'scene', tier: 'limited', name: '老书房',
    description: '纸页味、台灯、一整面书墙。', price: 260,
    affectionOnly: true, emoji: '📚', previewColor: '#8B6B4A',
  },
  {
    id: 'scene-summerbeach', kind: 'scene', tier: 'seasonal', name: '夏日海边',
    description: '风很大，它会被吹成一朵毛球。', price: 240,
    affectionOnly: true, emoji: '🏖️', previewColor: '#7FB2C4',
  },
  {
    id: 'prop-frame', kind: 'prop', tier: 'starter', name: '纪念相框',
    description: '把最喜欢的一张放进去。', price: 90,
    affectionOnly: true, emoji: '🖼️', previewColor: '#C89B6B',
  },
  {
    id: 'prop-album', kind: 'prop', tier: 'seasonal', name: '纪念相册皮肤',
    description: '手账封面的新皮肤。', price: 120,
    affectionOnly: true, emoji: '📔', previewColor: '#D7A88A',
  },
  {
    id: 'extra-play', kind: 'extra-interaction', tier: 'starter', name: '追加 3 次陪玩',
    description: '当日互动次数用完后，用好感度继续。', price: 40,
    affectionOnly: true, emoji: '🎾', previewColor: '#E8734A',
  },
];

/* ------------------------------------------------------------
 * 6. 订阅档位（说明书 十一）
 * ---------------------------------------------------------- */
export const SUBSCRIPTION_PLANS: SubscriptionPlan[] = [
  {
    tier: 'free', name: '免费', priceMonthly: 0, priceYearly: 0, guaranteedExperience: true,
    highlights: ['基础生成 1 只宠物', '日常互动与好感度', '基础打卡与手账', '完整首日体验'],
  },
  {
    tier: 'plus', name: 'Plus', priceMonthly: 25, priceYearly: 198, guaranteedExperience: false,
    highlights: ['3 个宠物位', '高级场景解锁', '限定服饰提前解锁', '高清导出'],
  },
  {
    tier: 'pro', name: 'Pro', priceMonthly: 48, priceYearly: 398, guaranteedExperience: false,
    highlights: ['6 个宠物位', '更长记忆容量', '语音对话优先通道', '手账模板全解锁', '云代养与双宠同行'],
  },
];

/* ------------------------------------------------------------
 * 7. 内置背景场景（说明书 4.7 环境：预渲染 + 轻量动态元素）
 * ---------------------------------------------------------- */
export interface ScenePreset {
  id: string;
  name: string;
  /** 背景渐变，用于降级渲染 */
  gradient: string;
  /** 光影方向，换场景时同步变化（说明书 3.3-4） */
  lightAngle: number;
  ambient: string;
}

export const SCENE_PRESETS: ScenePreset[] = [
  { id: 'home-warm', name: '午后客厅', gradient: 'linear-gradient(160deg,#FBF4E9 0%,#F1E2CE 60%,#E7D2B6 100%)', lightAngle: 135, ambient: 'rgba(255,214,170,0.55)' },
  { id: 'snow-night', name: '雪夜', gradient: 'linear-gradient(160deg,#E8EDF2 0%,#CBD6E0 55%,#A9B8C6 100%)', lightAngle: 210, ambient: 'rgba(180,205,230,0.5)' },
  { id: 'old-study', name: '老书房', gradient: 'linear-gradient(160deg,#EFE3D0 0%,#D9C3A3 55%,#B99B76 100%)', lightAngle: 100, ambient: 'rgba(255,196,120,0.45)' },
  { id: 'summer-beach', name: '夏日海边', gradient: 'linear-gradient(160deg,#EAF4F7 0%,#C9E2EA 50%,#9CC3CF 100%)', lightAngle: 170, ambient: 'rgba(200,235,245,0.5)' },
  { id: 'forest-morning', name: '林间清晨', gradient: 'linear-gradient(160deg,#F2F6EC 0%,#D8E5C9 55%,#B4C9A1 100%)', lightAngle: 85, ambient: 'rgba(190,225,170,0.45)' },
];
