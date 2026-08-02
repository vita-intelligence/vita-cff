"use client";

/**
 * Puck configuration for the RTG catalog page builder.
 *
 * Defines the component library staff drag onto the page canvas.
 * Each block has:
 * - ``fields``: prop panel Puck renders in the sidebar (padding,
 *   colors, alignment, etc.)
 * - ``defaultProps``: initial values when a block is dropped
 * - ``render``: the actual React component
 *
 * Blocks are grouped by intent — layout containers first, then
 * content primitives, then media / interactive. Every block ships
 * with sensible padding defaults so a fresh page looks reasonable
 * before an author touches a single prop.
 *
 * The same ``config`` object is used by the editor AND the portal
 * renderer so what staff sees at authoring time is byte-identical
 * to what the customer sees on the store page.
 */

import type { Config } from "@puckeditor/core";
import type { CSSProperties, ReactNode } from "react";


// ---------------------------------------------------------------------------
// Shared prop helpers
// ---------------------------------------------------------------------------


const ALIGN_OPTIONS = [
  { label: "Left", value: "left" },
  { label: "Center", value: "center" },
  { label: "Right", value: "right" },
];


function toPx(value: number | string | undefined | null): string | undefined {
  // Explicit ``0`` is a valid, intentional padding — don't drop it
  // through a falsy check. Anything unset / empty / non-numeric falls
  // through as ``undefined`` so CSS uses the browser default.
  if (value === undefined || value === null || value === "") return undefined;
  const n = typeof value === "number" ? value : Number(value);
  if (Number.isNaN(n)) return undefined;
  return `${n}px`;
}

function paddingStyle(padding: {
  top?: number | string;
  right?: number | string;
  bottom?: number | string;
  left?: number | string;
}): CSSProperties {
  return {
    paddingTop: toPx(padding.top),
    paddingRight: toPx(padding.right),
    paddingBottom: toPx(padding.bottom),
    paddingLeft: toPx(padding.left),
  };
}


// ---------------------------------------------------------------------------
// Block components + configs
// ---------------------------------------------------------------------------


interface SectionProps {
  padding: {
    top: number | string;
    right: number | string;
    bottom: number | string;
    left: number | string;
  };
  backgroundColor: string;
  textColor: string;
  maxWidth: number | string;
  align: "left" | "center" | "right";
  children: ReactNode;
}

function Section({
  padding,
  backgroundColor,
  textColor,
  maxWidth,
  align,
  children,
}: SectionProps) {
  // ``maxWidth: 0`` = full width (no cap). Anything positive caps
  // the inner container.
  const capped = toPx(maxWidth);
  return (
    <section
      style={{
        backgroundColor: backgroundColor || undefined,
        color: textColor || undefined,
        textAlign: align,
      }}
    >
      <div
        style={{
          ...paddingStyle(padding),
          margin: "0 auto",
          maxWidth: capped === "0px" ? undefined : capped,
        }}
      >
        {children}
      </div>
    </section>
  );
}


interface HeadingProps {
  text: string;
  level: "h1" | "h2" | "h3";
  align: "left" | "center" | "right";
  color: string;
  padding: {
    top: number | string;
    right: number | string;
    bottom: number | string;
    left: number | string;
  };
}

function Heading({ text, level, align, color, padding }: HeadingProps) {
  const Tag = level;
  const size =
    level === "h1"
      ? "2.25rem"
      : level === "h2"
        ? "1.75rem"
        : "1.375rem";
  return (
    <div style={paddingStyle(padding)}>
      <Tag
        style={{
          color: color || undefined,
          fontSize: size,
          fontWeight: 700,
          lineHeight: 1.2,
          margin: 0,
          textAlign: align,
        }}
      >
        {text || "Heading"}
      </Tag>
    </div>
  );
}


interface ParagraphProps {
  text: string;
  align: "left" | "center" | "right";
  color: string;
  fontSize: number | string;
  padding: {
    top: number | string;
    right: number | string;
    bottom: number | string;
    left: number | string;
  };
}

function Paragraph({
  text,
  align,
  color,
  fontSize,
  padding,
}: ParagraphProps) {
  return (
    <div style={paddingStyle(padding)}>
      <p
        style={{
          color: color || undefined,
          fontSize: toPx(fontSize) || "1rem",
          lineHeight: 1.65,
          margin: 0,
          textAlign: align,
          whiteSpace: "pre-wrap",
        }}
      >
        {text || "Add your copy here…"}
      </p>
    </div>
  );
}


interface ImageBlockProps {
  src: string;
  alt: string;
  align: "left" | "center" | "right";
  maxWidth: number | string;
  borderRadius: number | string;
  padding: {
    top: number | string;
    right: number | string;
    bottom: number | string;
    left: number | string;
  };
}

function ImageBlock({
  src,
  alt,
  align,
  maxWidth,
  borderRadius,
  padding,
}: ImageBlockProps) {
  const alignStyle: CSSProperties =
    align === "center"
      ? { textAlign: "center" }
      : align === "right"
        ? { textAlign: "right" }
        : { textAlign: "left" };
  const cappedWidth = toPx(maxWidth);
  if (!src) {
    return (
      <div
        style={{ ...paddingStyle(padding), ...alignStyle }}
        className="text-sm text-neutral-400"
      >
        [Image placeholder — paste an image URL in the sidebar]
      </div>
    );
  }
  return (
    <div style={{ ...paddingStyle(padding), ...alignStyle }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt || ""}
        style={{
          borderRadius: toPx(borderRadius),
          display: "inline-block",
          maxWidth: cappedWidth === "0px" ? "100%" : cappedWidth || "100%",
          width: "100%",
        }}
      />
    </div>
  );
}


interface VideoProps {
  url: string;
  padding: {
    top: number | string;
    right: number | string;
    bottom: number | string;
    left: number | string;
  };
}

function Video({ url, padding }: VideoProps) {
  // Accept both watch links and youtu.be shorts. Convert to the
  // nocookie embed URL for a lighter GDPR footprint.
  const embedUrl = toYoutubeEmbedUrl(url);
  if (!embedUrl) {
    return (
      <div
        style={paddingStyle(padding)}
        className="text-sm text-neutral-400"
      >
        [Video placeholder — paste a YouTube watch URL in the sidebar]
      </div>
    );
  }
  return (
    <div style={paddingStyle(padding)}>
      <div
        style={{
          aspectRatio: "16 / 9",
          overflow: "hidden",
          borderRadius: "0.5rem",
        }}
      >
        <iframe
          src={embedUrl}
          title="Embedded video"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
          style={{ border: "none", height: "100%", width: "100%" }}
        />
      </div>
    </div>
  );
}


function toYoutubeEmbedUrl(url: string): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    // https://www.youtube.com/watch?v=ID
    if (u.hostname.includes("youtube.com") && u.searchParams.has("v")) {
      return `https://www.youtube-nocookie.com/embed/${u.searchParams.get(
        "v",
      )}`;
    }
    // https://youtu.be/ID
    if (u.hostname === "youtu.be") {
      const id = u.pathname.replace(/^\//, "");
      if (id) return `https://www.youtube-nocookie.com/embed/${id}`;
    }
    // Already an embed
    if (
      u.hostname.includes("youtube") &&
      u.pathname.startsWith("/embed/")
    ) {
      return url;
    }
  } catch {
    // fall through
  }
  return null;
}


interface ButtonBlockProps {
  label: string;
  href: string;
  variant: "primary" | "secondary" | "ghost";
  size: "sm" | "md" | "lg";
  align: "left" | "center" | "right";
  padding: {
    top: number | string;
    right: number | string;
    bottom: number | string;
    left: number | string;
  };
}

function ButtonBlock({
  label,
  href,
  variant,
  size,
  align,
  padding,
}: ButtonBlockProps) {
  const alignStyle: CSSProperties = { textAlign: align };
  const sizeStyle: CSSProperties =
    size === "sm"
      ? { fontSize: "0.875rem", padding: "0.375rem 0.875rem" }
      : size === "lg"
        ? { fontSize: "1.125rem", padding: "0.75rem 1.5rem" }
        : { fontSize: "1rem", padding: "0.5rem 1.125rem" };
  const variantStyle: CSSProperties =
    variant === "secondary"
      ? {
          background: "#ffffff",
          border: "2px solid #262626",
          color: "#262626",
        }
      : variant === "ghost"
        ? {
            background: "transparent",
            border: "none",
            color: "#c2410c",
            textDecoration: "underline",
          }
        : {
            background: "#c2410c",
            border: "none",
            color: "#ffffff",
          };
  return (
    <div style={{ ...paddingStyle(padding), ...alignStyle }}>
      <a
        href={href || "#"}
        style={{
          borderRadius: "0.5rem",
          display: "inline-block",
          fontWeight: 600,
          textDecoration: variant === "ghost" ? "underline" : "none",
          ...sizeStyle,
          ...variantStyle,
        }}
      >
        {label || "Button"}
      </a>
    </div>
  );
}


interface DividerProps {
  color: string;
  thickness: number | string;
  padding: {
    top: number | string;
    right: number | string;
    bottom: number | string;
    left: number | string;
  };
}

function Divider({ color, thickness, padding }: DividerProps) {
  return (
    <div style={paddingStyle(padding)}>
      <hr
        style={{
          background: color || "#e6e6e6",
          border: "none",
          height: toPx(thickness) || "1px",
          margin: 0,
        }}
      />
    </div>
  );
}


interface SpacerProps {
  height: number | string;
}

function Spacer({ height }: SpacerProps) {
  return <div style={{ height: toPx(height) || "32px" }} aria-hidden />;
}


interface ColumnsProps {
  columns: number;
  gap: number | string;
  padding: {
    top: number | string;
    right: number | string;
    bottom: number | string;
    left: number | string;
  };
  left: ReactNode;
  middle: ReactNode;
  right: ReactNode;
}

function Columns({
  columns,
  gap,
  padding,
  left,
  middle,
  right,
}: ColumnsProps) {
  const cols = columns === 3 ? 3 : 2;
  return (
    <div
      style={{
        ...paddingStyle(padding),
        display: "grid",
        gap: toPx(gap) || "16px",
        gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
      }}
    >
      <div>{left}</div>
      <div>{middle}</div>
      {cols === 3 ? <div>{right}</div> : null}
    </div>
  );
}


// ---------------------------------------------------------------------------
// Shared field definitions
// ---------------------------------------------------------------------------


// Padding object field reused by every block. Four number inputs
// so authors can type any value in pixels — no dropdown limit.
const paddingField = {
  type: "object" as const,
  label: "Padding (px)",
  objectFields: {
    top: { type: "number" as const, label: "Top", min: 0 },
    right: { type: "number" as const, label: "Right", min: 0 },
    bottom: { type: "number" as const, label: "Bottom", min: 0 },
    left: { type: "number" as const, label: "Left", min: 0 },
  },
};


const alignField = {
  type: "radio" as const,
  label: "Text align",
  options: ALIGN_OPTIONS,
};


// ---------------------------------------------------------------------------
// Config export
// ---------------------------------------------------------------------------


// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const pageBuilderConfig: Config<any> = {
  // Root wraps the whole canvas. Kept minimal so the store page's
  // own shell (nav, footer) doesn't get duplicated here.
  root: {
    fields: {
      title: {
        type: "text",
        label: "Page title (internal)",
      },
    },
    defaultProps: {
      title: "Product page",
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    render: (({ children }: { children: ReactNode }) => (
      <div className="page-builder-root">{children}</div>
    )) as any,
  },
  categories: {
    layout: {
      title: "Layout",
      components: ["Section", "Columns", "Spacer", "Divider"],
    },
    content: {
      title: "Content",
      components: ["Heading", "Paragraph", "ButtonBlock"],
    },
    media: {
      title: "Media",
      components: ["ImageBlock", "Video"],
    },
  },
  components: {
    Section: {
      label: "Section",
      fields: {
        padding: paddingField,
        backgroundColor: { type: "text", label: "Background (#hex)" },
        textColor: { type: "text", label: "Text color (#hex)" },
        maxWidth: {
          type: "number",
          label: "Max width (px, 0 = full)",
          min: 0,
        },
        align: alignField,
      },
      defaultProps: {
        padding: { top: 48, right: 24, bottom: 48, left: 24 },
        backgroundColor: "",
        textColor: "",
        maxWidth: 1200,
        align: "left",
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      render: Section as any,
    },
    Heading: {
      label: "Heading",
      fields: {
        text: { type: "text", label: "Text" },
        level: {
          type: "radio",
          label: "Level",
          options: [
            { label: "H1", value: "h1" },
            { label: "H2", value: "h2" },
            { label: "H3", value: "h3" },
          ],
        },
        align: alignField,
        color: { type: "text", label: "Color (#hex)" },
        padding: paddingField,
      },
      defaultProps: {
        text: "Section heading",
        level: "h2",
        align: "left",
        color: "",
        padding: { top: 0, right: 0, bottom: 16, left: 0 },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      render: Heading as any,
    },
    Paragraph: {
      label: "Paragraph",
      fields: {
        text: {
          type: "textarea",
          label: "Text",
        },
        align: alignField,
        color: { type: "text", label: "Color (#hex)" },
        fontSize: {
          type: "number",
          label: "Font size (px)",
          min: 8,
        },
        padding: paddingField,
      },
      defaultProps: {
        text: "",
        align: "left",
        color: "",
        fontSize: 16,
        padding: { top: 0, right: 0, bottom: 16, left: 0 },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      render: Paragraph as any,
    },
    ImageBlock: {
      label: "Image",
      fields: {
        src: { type: "text", label: "Image URL" },
        alt: { type: "text", label: "Alt text" },
        align: alignField,
        maxWidth: {
          type: "number",
          label: "Max width (px, 0 = full)",
          min: 0,
        },
        borderRadius: {
          type: "number",
          label: "Corner radius (px)",
          min: 0,
        },
        padding: paddingField,
      },
      defaultProps: {
        src: "",
        alt: "",
        align: "center",
        maxWidth: 800,
        borderRadius: 8,
        padding: { top: 0, right: 0, bottom: 16, left: 0 },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      render: ImageBlock as any,
    },
    Video: {
      label: "YouTube Video",
      fields: {
        url: { type: "text", label: "YouTube URL" },
        padding: paddingField,
      },
      defaultProps: {
        url: "",
        padding: { top: 16, right: 0, bottom: 16, left: 0 },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      render: Video as any,
    },
    ButtonBlock: {
      label: "Button",
      fields: {
        label: { type: "text", label: "Label" },
        href: { type: "text", label: "URL" },
        variant: {
          type: "radio",
          label: "Style",
          options: [
            { label: "Primary", value: "primary" },
            { label: "Secondary", value: "secondary" },
            { label: "Ghost", value: "ghost" },
          ],
        },
        size: {
          type: "radio",
          label: "Size",
          options: [
            { label: "S", value: "sm" },
            { label: "M", value: "md" },
            { label: "L", value: "lg" },
          ],
        },
        align: alignField,
        padding: paddingField,
      },
      defaultProps: {
        label: "Shop now",
        href: "#",
        variant: "primary",
        size: "md",
        align: "left",
        padding: { top: 8, right: 0, bottom: 8, left: 0 },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      render: ButtonBlock as any,
    },
    Divider: {
      label: "Divider",
      fields: {
        color: { type: "text", label: "Color (#hex)" },
        thickness: {
          type: "number",
          label: "Thickness (px)",
          min: 1,
        },
        padding: paddingField,
      },
      defaultProps: {
        color: "#e6e6e6",
        thickness: 1,
        padding: { top: 16, right: 0, bottom: 16, left: 0 },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      render: Divider as any,
    },
    Spacer: {
      label: "Spacer",
      fields: {
        height: { type: "number", label: "Height (px)", min: 1 },
      },
      defaultProps: { height: 32 },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      render: Spacer as any,
    },
    Columns: {
      label: "Columns",
      fields: {
        columns: {
          type: "radio",
          label: "Column count",
          options: [
            { label: "2 columns", value: 2 },
            { label: "3 columns", value: 3 },
          ],
        },
        gap: { type: "number", label: "Gap (px)", min: 0 },
        padding: paddingField,
        // Slot fields let the author drop other blocks into each
        // column. Puck renders them as drop zones on the canvas.
        left: { type: "slot", label: "Left column" },
        middle: { type: "slot", label: "Middle column" },
        right: { type: "slot", label: "Right column (3-col only)" },
      },
      defaultProps: {
        columns: 2,
        gap: 24,
        padding: { top: 16, right: 0, bottom: 16, left: 0 },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      render: Columns as any,
    },
  },
};

// A tiny default document so a fresh page isn't a blank canvas —
// gives the author something to riff on.
export const pageBuilderStarter = {
  content: [
    {
      type: "Section",
      props: {
        id: "Section-starter-1",
        padding: { top: 48, right: 24, bottom: 48, left: 24 },
        backgroundColor: "#faf8f4",
        textColor: "",
        maxWidth: 1200,
        align: "center",
      },
    },
    {
      type: "Heading",
      props: {
        id: "Heading-starter-1",
        text: "Welcome to your product page",
        level: "h1",
        align: "center",
        color: "",
        padding: { top: 0, right: 0, bottom: 16, left: 0 },
      },
    },
    {
      type: "Paragraph",
      props: {
        id: "Paragraph-starter-1",
        text: "Use the sidebar on the left to drag blocks onto the canvas. Every block has its own padding, colours and layout controls — click one to see them in the right sidebar.",
        align: "center",
        color: "#404040",
        fontSize: 18,
        padding: { top: 0, right: 0, bottom: 24, left: 0 },
      },
    },
  ],
  root: { props: { title: "Product page" } },
} as const;
