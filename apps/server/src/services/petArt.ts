/**
 * 本地降级宠物形象（SVG）。
 *
 * 用途：未接入真实 3D 生成服务时，前端用这张图作为「形象母版」渲染。
 * 它按物种 + 配色生成确定性矢量形象，并带一套 CSS 动画（呼吸/眨眼/摇尾），
 * 因此即使在 Mock 模式下，宠物也是「活着」的（说明书 3.3-2）。
 *
 * 接入 Tripo/Meshy 后，这个接口仍然保留为低端机降级通道（说明书 4.7 降级策略）。
 */

const PALETTE: Record<string, { base: string; accent: string; dark: string; eye: string }> = {
  oat: { base: '#F3E7D6', accent: '#E4D2B8', dark: '#C9B394', eye: '#5B4636' },
  chestnut: { base: '#B07C55', accent: '#8E6242', dark: '#6B4930', eye: '#3A2A1E' },
  coral: { base: '#F59B7E', accent: '#E8734A', dark: '#C2553A', eye: '#5B3226' },
  cream: { base: '#F7EBCB', accent: '#EBD9A8', dark: '#CDB886', eye: '#5B4636' },
  sage: { base: '#B9C9A8', accent: '#9CB088', dark: '#7A8F6A', eye: '#3F4A36' },
  slate: { base: '#B7BEC7', accent: '#98A2AE', dark: '#78838F', eye: '#3A4149' },
  ink: { base: '#5A5450', accent: '#403B38', dark: '#2C2825', eye: '#F0E6DA' },
  plum: { base: '#A88AA8', accent: '#8C6E8C', dark: '#6B5268', eye: '#3F2E3F' },
};

const SPECIES_SHAPE: Record<string, { ears: 'long' | 'round' | 'pointy' | 'small' | 'none'; tail: 'curl' | 'bushy' | 'short' | 'puff' | 'none'; snout: 'flat' | 'medium' | 'long'; extra?: string }> = {
  ragdoll: { ears: 'pointy', tail: 'bushy', snout: 'flat' },
  corgi: { ears: 'pointy', tail: 'short', snout: 'long' },
  shiba: { ears: 'pointy', tail: 'curl', snout: 'medium' },
  bunny: { ears: 'long', tail: 'puff', snout: 'flat' },
  hamster: { ears: 'small', tail: 'short', snout: 'flat' },
  fox: { ears: 'pointy', tail: 'bushy', snout: 'long' },
  fawn: { ears: 'small', tail: 'short', snout: 'long', extra: 'antler' },
  capybara: { ears: 'small', tail: 'none', snout: 'long' },
  alpaca: { ears: 'long', tail: 'puff', snout: 'medium', extra: 'fluff' },
  bird: { ears: 'none', tail: 'short', snout: 'flat', extra: 'beak' },
  chimera: { ears: 'round', tail: 'curl', snout: 'medium', extra: 'sparkle' },
};

export function renderPetSvg(opts: { species: string; palette: string[]; name: string }): string {
  const shape = SPECIES_SHAPE[opts.species] ?? SPECIES_SHAPE.ragdoll!;
  const c1 = PALETTE[opts.palette[0] ?? 'oat'] ?? PALETTE.oat!;
  const c2 = PALETTE[opts.palette[1] ?? 'chestnut'] ?? PALETTE.chestnut!;

  const ears = () => {
    switch (shape.ears) {
      case 'long':
        return `<ellipse cx="120" cy="96" rx="17" ry="52" fill="${c1.base}" stroke="${c1.dark}" stroke-width="4" transform="rotate(-14 120 96)"/>
                <ellipse cx="200" cy="96" rx="17" ry="52" fill="${c1.base}" stroke="${c1.dark}" stroke-width="4" transform="rotate(14 200 96)"/>
                <ellipse cx="120" cy="100" rx="8" ry="34" fill="${c2.accent}" opacity="0.7" transform="rotate(-14 120 100)"/>
                <ellipse cx="200" cy="100" rx="8" ry="34" fill="${c2.accent}" opacity="0.7" transform="rotate(14 200 100)"/>`;
      case 'pointy':
        return `<path d="M118 122 L138 52 L176 116 Z" fill="${c1.base}" stroke="${c1.dark}" stroke-width="4" stroke-linejoin="round"/>
                <path d="M212 122 L192 52 L154 116 Z" fill="${c1.base}" stroke="${c1.dark}" stroke-width="4" stroke-linejoin="round"/>
                <path d="M132 112 L142 72 L164 110 Z" fill="${c2.accent}" opacity="0.65"/>
                <path d="M198 112 L188 72 L166 110 Z" fill="${c2.accent}" opacity="0.65"/>`;
      case 'round':
        return `<circle cx="118" cy="94" r="30" fill="${c1.base}" stroke="${c1.dark}" stroke-width="4"/>
                <circle cx="212" cy="94" r="30" fill="${c1.base}" stroke="${c1.dark}" stroke-width="4"/>
                <circle cx="118" cy="94" r="14" fill="${c2.accent}" opacity="0.6"/>
                <circle cx="212" cy="94" r="14" fill="${c2.accent}" opacity="0.6"/>`;
      case 'small':
        return `<ellipse cx="126" cy="104" rx="20" ry="16" fill="${c1.base}" stroke="${c1.dark}" stroke-width="4"/>
                <ellipse cx="204" cy="104" rx="20" ry="16" fill="${c1.base}" stroke="${c1.dark}" stroke-width="4"/>`;
      default:
        return '';
    }
  };

  const tail = () => {
    switch (shape.tail) {
      case 'bushy':
        return `<ellipse class="rt-tail" cx="292" cy="268" rx="34" ry="56" fill="${c2.base}" stroke="${c2.dark}" stroke-width="4" transform="rotate(18 292 268)"/>`;
      case 'curl':
        return `<path class="rt-tail" d="M282 252 C336 236 348 190 316 182 C300 178 292 194 304 202" fill="none" stroke="${c2.dark}" stroke-width="20" stroke-linecap="round"/>`;
      case 'puff':
        return `<circle class="rt-tail" cx="288" cy="272" r="26" fill="${c1.accent}" stroke="${c1.dark}" stroke-width="4"/>`;
      case 'short':
        return `<path class="rt-tail" d="M280 268 L310 258" stroke="${c1.dark}" stroke-width="18" stroke-linecap="round"/>`;
      default:
        return '';
    }
  };

  const extra = () => {
    if (shape.extra === 'antler') {
      return `<path d="M140 62 L128 26 L112 38 M128 26 L146 18" stroke="${c2.dark}" stroke-width="6" fill="none" stroke-linecap="round"/>
              <path d="M190 62 L202 26 L218 38 M202 26 L184 18" stroke="${c2.dark}" stroke-width="6" fill="none" stroke-linecap="round"/>`;
    }
    if (shape.extra === 'beak') {
      return `<path d="M152 186 L188 200 L152 214 Z" fill="${c2.accent}" stroke="${c2.dark}" stroke-width="3" stroke-linejoin="round"/>`;
    }
    if (shape.extra === 'fluff') {
      return `<circle cx="112" cy="152" r="20" fill="${c1.base}" opacity="0.95"/><circle cx="218" cy="152" r="20" fill="${c1.base}" opacity="0.95"/>`;
    }
    if (shape.extra === 'sparkle') {
      return `<text x="252" y="96" font-size="30" opacity="0.85">✨</text>`;
    }
    return '';
  };

  const snoutSvg = shape.snout === 'long'
    ? `<ellipse cx="170" cy="196" rx="34" ry="24" fill="${c1.accent}" stroke="${c1.dark}" stroke-width="4"/>
       <ellipse cx="170" cy="186" rx="10" ry="7" fill="${c1.eye}"/>`
    : `<ellipse cx="170" cy="198" rx="24" ry="16" fill="${c1.accent}" stroke="${c1.dark}" stroke-width="3"/>
       <path d="M170 192 l-8 8 h16 z" fill="${c1.eye}"/>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 340 360" width="340" height="360" role="img" aria-label="${escapeXml(opts.name)}">
  <defs>
    <radialGradient id="shadow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0%" stop-color="#000" stop-opacity="0.20"/><stop offset="100%" stop-color="#000" stop-opacity="0"/>
    </radialGradient>
    <style>
      .rt-body { transform-origin: 170px 300px; animation: rt-breathe 4s ease-in-out infinite; }
      .rt-head { transform-origin: 170px 200px; animation: rt-head 5s ease-in-out infinite; }
      .rt-eye { transform-origin: center; animation: rt-blink 5.5s ease-in-out infinite; }
      .rt-tail { transform-origin: 280px 258px; animation: rt-tail 1.8s ease-in-out infinite; }
      @keyframes rt-breathe { 0%,100% { transform: scale(1) translateY(0); } 50% { transform: scale(1.015) translateY(-3px); } }
      @keyframes rt-head { 0%,100% { transform: rotate(-1.2deg); } 50% { transform: rotate(1.6deg); } }
      @keyframes rt-blink { 0%,92%,100% { transform: scaleY(1); } 95% { transform: scaleY(0.1); } }
      @keyframes rt-tail { 0%,100% { transform: rotate(-9deg); } 50% { transform: rotate(11deg); } }
      @media (prefers-reduced-motion: reduce) { .rt-body,.rt-head,.rt-eye,.rt-tail { animation: none; } }
    </style>
  </defs>
  <ellipse cx="170" cy="330" rx="96" ry="20" fill="url(#shadow)"/>
  ${tail()}
  <g class="rt-body">
    ${ears()}
    ${extra()}
    <g class="rt-head">
      <ellipse cx="170" cy="186" rx="86" ry="82" fill="${c1.base}" stroke="${c1.dark}" stroke-width="5"/>
      <ellipse cx="140" cy="212" rx="34" ry="26" fill="${c1.accent}" opacity="0.55"/>
      <ellipse cx="200" cy="164" rx="30" ry="22" fill="${c2.accent}" opacity="0.45"/>
      ${snoutSvg}
      <circle class="rt-eye" cx="142" cy="166" r="11" fill="${c1.eye}"/>
      <circle class="rt-eye" cx="198" cy="166" r="11" fill="${c1.eye}"/>
      <circle cx="146" cy="162" r="3.6" fill="#fff" opacity="0.9"/>
      <circle cx="202" cy="162" r="3.6" fill="#fff" opacity="0.9"/>
      <path d="M118 148 q10 -10 22 -4" stroke="${c1.dark}" stroke-width="3" fill="none" opacity="0.5" stroke-linecap="round"/>
      <path d="M200 144 q12 -6 22 4" stroke="${c1.dark}" stroke-width="3" fill="none" opacity="0.5" stroke-linecap="round"/>
    </g>
    <ellipse cx="170" cy="300" rx="76" ry="52" fill="${c1.base}" stroke="${c1.dark}" stroke-width="5"/>
    <ellipse cx="170" cy="308" rx="44" ry="32" fill="${c1.accent}" opacity="0.6"/>
    <ellipse cx="132" cy="332" rx="24" ry="13" fill="${c1.base}" stroke="${c1.dark}" stroke-width="4"/>
    <ellipse cx="208" cy="332" rx="24" ry="13" fill="${c1.base}" stroke="${c1.dark}" stroke-width="4"/>
  </g>
</svg>`;
}

function escapeXml(input: string): string {
  return input.replace(/[<>&"']/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c] as string,
  );
}
