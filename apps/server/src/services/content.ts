/**
 * 内容生成引擎（说明书 3.2-6 / 7.2-⑦ / 7.3）
 *
 * 全部走「模板 + 变量填充」，不依赖大模型即可产出真实可读的内容；
 * 如果配置了大模型，会再做一次「润色」调用（失败则静默保留模板版本）。
 * 这样既保证零成本可跑，也保证接入模型后质量能提升。
 */
import type {
  Destination,
  DestinationScene,
  JournalBlock,
  JournalEntry,
  JournalTemplate,
  Pet,
  Postcard,
  WeatherSnapshot,
} from '../../../../packages/shared/src/index.ts';

const pick = <T>(arr: T[], seed: number): T => arr[Math.floor(seed * arr.length) % arr.length] as T;
const hash = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h % 100000) / 100000;
};

export const SCENE_NAMES: Record<DestinationScene, string> = {
  mountain: '山野',
  seaside: '海边',
  city: '城市街区',
  'foreign-alley': '异国小巷',
  snow: '雪夜',
  desert: '沙漠',
};

/* ============================================================
 * 旅行手账（时间轴：照片 + 文案 + 宠物出镜）
 * ============================================================ */
const JOURNAL_OPENERS = [
  '{pet}今天没什么意见，只是把所有能闻的地方都闻了一遍。',
  '出发的时候{pet}在包里睡了一路，醒来的时候我们已经到了。',
  '{pet}说这里的光比家里暖，我怀疑它只是想多待一会儿。',
];

const JOURNAL_BODY = [
  '我们在这里待了大概两个小时。{pet}几乎全程贴着我的腿，偶尔抬头看我一眼，确认我没有走掉。',
  '{pet}对{landmark}表现出了职业级别的兴趣，对拍照则完全没有耐心。最后那张勉强算合影。',
  '走了很久的路。{pet}一开始走在前面，后来改成走在我脚边，最后干脆赖着不走。我抱着它走完了剩下的一段。',
  '{pet}今天的社交欲很强，对三个陌生人摇了尾巴，对一只同类保持了高冷。它说这叫分寸。',
];

const JOURNAL_CLOSERS = [
  '回去的路上它睡着了。我猜今天它是满意的。',
  '这大概不是我拍过最好看的地方，但可能是{pet}最认真看过的一个。',
  '下次来的时候，它应该还会记得这条路。我赌它会走在同一侧。',
];

/** 每个目的地的小地标词，让文案不那么通用 */
const LANDMARKS: Record<string, string[]> = {
  chengdu: ['那张竹椅', '茶馆门口的招牌', '巷子里的红油味'],
  sanya: ['第一波浪', '退潮后的沙面', '椰子摊上的吸管'],
  lijiang: ['石板路的声音', '邮局门口的绿色邮筒', '雪山露出来的那五分钟'],
  tokyo: ['贩卖机的灯', '深夜食堂的小碟子', '便利店的屋檐'],
  harbin: ['第一场雪', '冰雕里的自己', '暖气片旁边的位置'],
  dunhuang: ['骆驼的眼神', '沙丘的坡', '夜里那片过分的星空'],
};

export function generateJournal(input: {
  pet: Pet;
  destination: Destination;
  checkinId: string | null;
  template?: JournalTemplate;
  composedPhotoUrl?: string;
  revisitMemory?: string | null;
  extraNote?: string;
  weather?: WeatherSnapshot;
}): JournalEntry {
  const { pet, destination } = input;
  const seed = hash(`${pet.id}-${destination.id}-${input.checkinId ?? 'na'}`);
  const landmark = pick(LANDMARKS[destination.id] ?? ['这条路', '这个下午'], seed);
  const chapter = destination.storyChapters[0]?.content ?? '';

  const vars = { pet: pet.name, landmark, place: destination.name };
  const fill = (tpl: string) => tpl.replace(/\{(\w+)\}/g, (_, k: string) => (vars as Record<string, string>)[k] ?? '');

  const title = `${destination.name}｜${destination.storyTitle}`;
  const paragraphs = [
    fill(pick(JOURNAL_OPENERS, seed)),
    fill(pick(JOURNAL_BODY, seed * 1.7)),
    chapter,
    fill(pick(JOURNAL_CLOSERS, seed * 2.3)),
  ];

  if (input.revisitMemory) paragraphs.splice(1, 0, input.revisitMemory);
  if (input.extraNote) paragraphs.push(input.extraNote);
  if (input.weather) {
    paragraphs.push(`那天${input.weather.condition}，${input.weather.temperature}℃，${input.weather.advice}`);
  }

  const blocks: JournalBlock[] = [
    {
      type: 'photo',
      url: input.composedPhotoUrl ?? '',
      caption: `${pet.name}在${destination.name}`,
      petInFrame: true,
    },
    { type: 'text', content: paragraphs[0] as string },
    { type: 'text', content: paragraphs[1] as string },
    { type: 'quote', content: chapter, author: `${pet.name}（宠物视角）` },
    { type: 'badge', badgeId: `badge-${destination.id}`, label: destination.name, emoji: destination.emoji },
    ...paragraphs.slice(2).map((p) => ({ type: 'text' as const, content: p })),
  ];

  return {
    id: `jrn-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    petId: pet.id,
    checkinId: input.checkinId,
    title,
    body: paragraphs.join('\n\n'),
    template: input.template ?? (pet.vector.photoHabit === 'heavy' ? 'polaroid' : 'warm-paper'),
    blocks,
    destinationName: destination.name,
    tags: [SCENE_NAMES[destination.scene], destination.region, pet.species],
    createdAt: new Date().toISOString(),
  };
}

/* ============================================================
 * 宠物视角明信片（说明书 7.2-⑦）
 * ============================================================ */
const POSTCARD_TEMPLATES = [
  '今天她带我走了两万步，我在包里睡了一路。醒来的时候，海就在前面。',
  '{place}的风很大，我的毛全部朝一个方向倒。她笑我，笑完把我抱起来了。',
  '我不太懂为什么人要拍这么多照片。不过她拍我的时候，我会配合一下。',
  '她说这个地方她想来很久了。我信了，因为她在这里走路都比平时慢。',
  '回去之后我大概会忘记这里的名字，但我记得今天她一直在说话，说给我听。',
  '这里的味道和家不一样。我把其中一种记下来了，回去讲给你听。',
];

export function generatePostcard(input: {
  pet: Pet;
  destination: Destination;
  checkinId: string | null;
  to?: string;
  template?: Postcard['template'];
}): Postcard {
  const { pet, destination } = input;
  const seed = hash(`${destination.id}-${pet.id}-postcard`);
  const text = pick(POSTCARD_TEMPLATES, seed).replace(/\{place\}/g, destination.name);
  return {
    id: `pc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    petId: pet.id,
    checkinId: input.checkinId,
    text,
    to: input.to?.trim() || '看到这张卡片的你',
    signature: `${pet.name}（爪印）`,
    scene: destination.scene,
    template: input.template ?? 'postcard-classic',
    createdAt: new Date().toISOString(),
  };
}

/* ============================================================
 * 宠物心愿单台词（说明书 7.2-①：让线下行为变成宠物的邀请）
 * ============================================================ */
export function wishQuote(pet: Pet, destination: Destination, seed = Math.random()): string {
  const base = [
    `我在你手机地图上看到${destination.name}了。那个地方，我们什么时候去？`,
    `听说${destination.name}有${destination.exclusiveSkin?.name ?? '很好吃的东西'}。我不催你，我只是提一下。`,
    `${destination.storyTitle}——这个故事我想亲自去一趟。`,
  ];
  return pick(base, seed).replace('{place}', destination.name);
}

/* ============================================================
 * 时光机：再次到访的回忆（说明书 7.2-⑨）
 * ============================================================ */
export function revisitLine(pet: Pet, destination: Destination, previousVisitIso: string, daysAgo: number): string {
  const month = new Date(previousVisitIso).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long' });
  return `上次来${destination.name}是${month}的事，隔了 ${daysAgo} 天。${pet.name}在那块石头上又停了一下，和前一次停在同一个位置。`;
}

/* ============================================================
 * 出行前播报（说明书 7.2-⑩）
 * ============================================================ */
const WEATHER_POOL: WeatherSnapshot[] = [
  { condition: '晴', temperature: 26, advice: '适合在外面待久一点', emoji: '☀️' },
  { condition: '小雨', temperature: 18, advice: '记得带伞，它不喜欢淋湿', emoji: '🌧️' },
  { condition: '降温', temperature: 9, advice: '那边降温了，记得带外套', emoji: '🧥' },
  { condition: '多云', temperature: 21, advice: '光线很柔，适合拍照', emoji: '⛅' },
  { condition: '大风', temperature: 15, advice: '风会把它的毛吹成一朵', emoji: '🌬️' },
];

export function fakeWeather(destinationId: string, seed = 0.5): WeatherSnapshot {
  const combined = (hash(destinationId) + seed) % 1;
  return pick(WEATHER_POOL, combined);
}

export function travelAlert(pet: Pet, destination: Destination, weather: WeatherSnapshot): string {
  return `${pet.name}播报：我们要去${destination.name}了。${weather.emoji} 那边${weather.condition}，${weather.temperature}℃，${weather.advice}。`;
}

/* ============================================================
 * 记忆摘要（说明书 6.2 记忆系统）
 * ============================================================ */
export function summarizeConversation(messages: { role: string; content: string }[]): string {
  if (!messages.length) return '';
  const userLines = messages.filter((m) => m.role === 'user').map((m) => m.content).slice(-4);
  const petLines = messages.filter((m) => m.role === 'pet').map((m) => m.content).slice(-2);
  const key = userLines.join('；').slice(0, 60);
  return `主人聊到了：${key}。我的回应：${petLines.join(' / ').slice(0, 40)}`;
}

/** 从对话里提炼关键事件（生日、第一次、承诺） */
export function extractKeyEvents(text: string): string[] {
  const events: string[] = [];
  const rules: { re: RegExp; tpl: (m: RegExpMatchArray) => string }[] = [
    { re: /(生日|过生日)/, tpl: () => '主人提到过生日' },
    { re: /(第一次|头一回)/, tpl: (m) => `主人提到「第一次${m.input?.slice(Math.max(0, (m.index ?? 0) - 8), (m.index ?? 0) + 12) ?? ''}」` },
    { re: /(我会|我答应|答应你)/, tpl: () => '主人对我做了承诺' },
    { re: /(加班|出差|很忙)/, tpl: () => '主人最近很忙' },
    { re: /(妈妈|爸爸|家人|朋友)/, tpl: () => '主人提到了家人或朋友' },
  ];
  for (const r of rules) {
    const m = text.match(r.re);
    if (m) events.push(r.tpl(m));
  }
  return events.slice(0, 2);
}
