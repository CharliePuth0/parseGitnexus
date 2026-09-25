import type { SVGProps } from 'react';
import type { RiskCode } from '../types/report';

/* ---------------------------------------------------------------- kind glyph */

/**
 * 符号类型用字母字形表示(等宽字体 + 描边方块),比 emoji 更适合内部工具,
 * 也避免不同平台 emoji 字体渲染不一致。
 */
const KIND_GLYPHS: Record<string, string> = {
  function: 'fn',
  method: 'm',
  class: 'C',
  interface: 'I',
  struct: 'S',
  enum: 'E',
  'enum member': 'e',
  variable: 'v',
  constant: 'c',
  const: 'c',
  property: 'p',
  field: 'f',
  type: 'T',
  typealias: 'T',
  'type alias': 'T',
  module: 'M',
  file: 'F',
  namespace: 'N',
  constructor: 'ct',
  decorator: 'D',
  trait: 'Tr',
  impl: 'Im',
  protocol: 'P',
  record: 'R',
  macro: 'Ma',
  getter: 'g',
  setter: 's',
  unknown: '?',
};

export function kindGlyph(kind: string): string {
  const key = (kind ?? '').trim().toLowerCase();
  const mapped = KIND_GLYPHS[key];
  if (mapped) return mapped;
  return key === '' ? '?' : key.slice(0, 2);
}

export function KindGlyph({ kind, large = false }: { kind: string; large?: boolean }) {
  return (
    <span className={large ? 'kind kind--lg' : 'kind'} aria-hidden="true" title={kind}>
      {kindGlyph(kind)}
    </span>
  );
}

/* ---------------------------------------------------------------- risk mark */

/**
 * 风险标记:形状 + 颜色双重编码(严重=八边形 / 高=三角 / 中=菱形 / 低=圆 / 未知=虚线圈),
 * 因此即使色觉异常或灰度打印,等级依然可辨。
 */
export function RiskMark({ risk, ...rest }: { risk: RiskCode } & SVGProps<SVGSVGElement>) {
  const common = { width: 12, height: 12, viewBox: '0 0 12 12', 'aria-hidden': true } as const;
  switch (risk) {
    case 'CRITICAL':
      return (
        <svg {...common} {...rest} fill="currentColor">
          <path d="M3.9 0.6H8.1L11.4 3.9V8.1L8.1 11.4H3.9L0.6 8.1V3.9Z" />
        </svg>
      );
    case 'HIGH':
      return (
        <svg {...common} {...rest} fill="currentColor">
          <path d="M6 0.9L11.4 10.7H0.6Z" />
        </svg>
      );
    case 'MEDIUM':
      return (
        <svg {...common} {...rest} fill="currentColor">
          <path d="M6 0.7L11.3 6L6 11.3L0.7 6Z" />
        </svg>
      );
    case 'LOW':
      return (
        <svg {...common} {...rest} fill="currentColor">
          <circle cx="6" cy="6" r="5.2" />
        </svg>
      );
    default:
      return (
        <svg {...common} {...rest} fill="none">
          <circle cx="6" cy="6" r="4.9" stroke="currentColor" strokeWidth="1.6" strokeDasharray="2.6 2.1" />
        </svg>
      );
  }
}

/* ---------------------------------------------------------------- direction */

export function DirectionArrow({
  direction,
  ...rest
}: { direction: 'upstream' | 'downstream' | 'flat' } & SVGProps<SVGSVGElement>) {
  const common = {
    width: 12,
    height: 12,
    viewBox: '0 0 12 12',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  if (direction === 'upstream') {
    return (
      <svg {...common} {...rest}>
        <path d="M10.5 6H1.8M5 2.8L1.5 6L5 9.2" />
      </svg>
    );
  }
  if (direction === 'downstream') {
    return (
      <svg {...common} {...rest}>
        <path d="M1.5 6H10.2M7 2.8L10.5 6L7 9.2" />
      </svg>
    );
  }
  return (
    <svg {...common} {...rest}>
      <path d="M2 6H10" />
    </svg>
  );
}

/* ---------------------------------------------------------------- ui icons */

function Stroke({ children, ...rest }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const SearchIcon = (props: SVGProps<SVGSVGElement>) => (
  <Stroke {...props} width="13" height="13">
    <circle cx="7" cy="7" r="4.2" />
    <path d="M10.2 10.2L14 14" />
  </Stroke>
);

export const UploadIcon = (props: SVGProps<SVGSVGElement>) => (
  <Stroke {...props} width="16" height="16">
    <path d="M8 11V3M5 6L8 3L11 6" />
    <path d="M2.5 10.5v1.6a1.4 1.4 0 0 0 1.4 1.4h8.2a1.4 1.4 0 0 0 1.4-1.4v-1.6" />
  </Stroke>
);

export const WarningIcon = (props: SVGProps<SVGSVGElement>) => (
  <Stroke {...props} width="13" height="13">
    <path d="M8 2.2L14.2 13H1.8Z" />
    <path d="M8 6.4v2.8M8 11.2v.1" />
  </Stroke>
);

export const InfoIcon = (props: SVGProps<SVGSVGElement>) => (
  <Stroke {...props} width="13" height="13">
    <circle cx="8" cy="8" r="6" />
    <path d="M8 7.2v4M8 4.9v.1" />
  </Stroke>
);

export const CloseIcon = (props: SVGProps<SVGSVGElement>) => (
  <Stroke {...props} width="13" height="13">
    <path d="M3.6 3.6l8.8 8.8M12.4 3.6l-8.8 8.8" />
  </Stroke>
);

export const ChevronIcon = (props: SVGProps<SVGSVGElement>) => (
  <Stroke {...props} width="12" height="12">
    <path d="M4 6l4 4l4-4" />
  </Stroke>
);

export const ResetIcon = (props: SVGProps<SVGSVGElement>) => (
  <Stroke {...props} width="13" height="13">
    <path d="M2.6 8a5.4 5.4 0 1 0 1.7-3.9" />
    <path d="M2.2 2.4v3.2h3.2" />
  </Stroke>
);

export const DocIcon = (props: SVGProps<SVGSVGElement>) => (
  <Stroke {...props} width="13" height="13">
    <path d="M9.2 1.8H4.4a1.4 1.4 0 0 0-1.4 1.4v9.6a1.4 1.4 0 0 0 1.4 1.4h7.2a1.4 1.4 0 0 0 1.4-1.4V5.6Z" />
    <path d="M9.2 1.8v3.8h3.8" />
  </Stroke>
);

export const FlowIcon = (props: SVGProps<SVGSVGElement>) => (
  <Stroke {...props} width="13" height="13">
    <circle cx="4" cy="3.6" r="1.8" />
    <circle cx="12" cy="8" r="1.8" />
    <circle cx="4" cy="12.4" r="1.8" />
    <path d="M5.7 4.4l4.6 2.8M5.7 11.6l4.6-2.8" />
  </Stroke>
);
