// Line icons for the phone layout, drawn on a 24 grid in the current text colour.
const base = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round" } as const;
type P = { size?: number; className?: string };
const svg = (size = 22, className?: string) => ({ ...base, width: size, height: size, className, "aria-hidden": true });

export const IconChart = ({ size, className }: P) => (
  <svg {...svg(size, className)}>
    <path d="M7 4v3M7 15v5M16 5v4M16 17v2" />
    <rect x="5" y="7" width="4" height="8" rx="1" />
    <rect x="14" y="9" width="4" height="8" rx="1" />
  </svg>
);
export const IconLevels = ({ size, className }: P) => (
  <svg {...svg(size, className)}>
    <path d="M4 6h10M4 10h16M4 14h12M4 18h7" />
  </svg>
);
export const IconScan = ({ size, className }: P) => (
  <svg {...svg(size, className)}>
    <path d="M3 12h4l2.5-6 5 12 2.5-6h4" />
  </svg>
);
export const IconNews = ({ size, className }: P) => (
  <svg {...svg(size, className)}>
    <rect x="4" y="4" width="16" height="16" rx="2.5" />
    <path d="M8 9h8M8 13h8M8 17h5" />
  </svg>
);
export const IconInfo = ({ size, className }: P) => (
  <svg {...svg(size, className)}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11v5M12 8h.01" />
  </svg>
);
export const IconLayers = ({ size, className }: P) => (
  <svg {...svg(size, className)}>
    <path d="m12 4 8.5 4.5L12 13 3.5 8.5 12 4Z" />
    <path d="m3.5 12.5 8.5 4.5 8.5-4.5" />
    <path d="m3.5 16.5 8.5 4.5 8.5-4.5" />
  </svg>
);
export const IconChevron = ({ size = 16, className }: P) => (
  <svg {...svg(size, className)}>
    <path d="m6 9 6 6 6-6" />
  </svg>
);
export const IconSearch = ({ size = 16, className }: P) => (
  <svg {...svg(size, className)}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m20 20-4-4" />
  </svg>
);
