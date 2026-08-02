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


/** Spacing preset (matches Tailwind's rem scale) — 0 / 4 / 8 / 16 /
 *  24 / 32 / 48 / 64 / 96 px. Picker rather than free-text keeps the
 *  canvas visually consistent and avoids a scientist typing "1000px"
 *  by accident. */
const SPACING_OPTIONS = [
  { label: "None", value: "0" },
  { label: "XS (4)", value: "4" },
  { label: "S (8)", value: "8" },
  { label: "M (16)", value: "16" },
  { label: "L (24)", value: "24" },
  { label: "XL (32)", value: "32" },
  { label: "2XL (48)", value: "48" },
  { label: "3XL (64)", value: "64" },
  { label: "4XL (96)", value: "96" },
];

const ALIGN_OPTIONS = [
  { label: "Left", value: "left" },
  { label: "Center", value: "center" },
  { label: "Right", value: "right" },
];

const MAX_WIDTH_OPTIONS = [
  { label: "Narrow (640)", value: "640" },
  { label: "Medium (960)", value: "960" },
  { label: "Wide (1200)", value: "1200" },
  { label: "Full width", value: "" },
];


function paddingStyle(padding: {
  top?: string;
  right?: string;
  bottom?: string;
  left?: string;
}): CSSProperties {
  return {
    paddingTop: padding.top ? `${padding.top}px` : undefined,
    paddingRight: padding.right ? `${padding.right}px` : undefined,
    paddingBottom: padding.bottom ? `${padding.bottom}px` : undefined,
    paddingLeft: padding.left ? `${padding.left}px` : undefined,
  };
}


// ---------------------------------------------------------------------------
// Block components + configs
// ---------------------------------------------------------------------------


interface SectionProps {
  padding: {
    top: string;
    right: string;
    bottom: string;
    left: string;
  };
  backgroundColor: string;
  textColor: string;
  maxWidth: string;
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
          maxWidth: maxWidth ? `${maxWidth}px` : undefined,
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
    top: string;
    right: string;
    bottom: string;
    left: string;
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
  fontSize: string;
  padding: {
    top: string;
    right: string;
    bottom: string;
    left: string;
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
          fontSize: fontSize ? `${fontSize}px` : "1rem",
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
  maxWidth: string;
  borderRadius: string;
  padding: {
    top: string;
    right: string;
    bottom: string;
    left: string;
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
          borderRadius: borderRadius ? `${borderRadius}px` : undefined,
          display: "inline-block",
          maxWidth: maxWidth ? `${maxWidth}px` : "100%",
          width: "100%",
        }}
      />
    </div>
  );
}


interface VideoProps {
  url: string;
  padding: {
    top: string;
    right: string;
    bottom: string;
    left: string;
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
    top: string;
    right: string;
    bottom: string;
    left: string;
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
  thickness: string;
  padding: {
    top: string;
    right: string;
    bottom: string;
    left: string;
  };
}

function Divider({ color, thickness, padding }: DividerProps) {
  return (
    <div style={paddingStyle(padding)}>
      <hr
        style={{
          background: color || "#e6e6e6",
          border: "none",
          height: thickness ? `${thickness}px` : "1px",
          margin: 0,
        }}
      />
    </div>
  );
}


interface SpacerProps {
  height: string;
}

function Spacer({ height }: SpacerProps) {
  return <div style={{ height: `${height || "32"}px` }} aria-hidden />;
}


interface ColumnsProps {
  columns: number;
  gap: string;
  padding: {
    top: string;
    right: string;
    bottom: string;
    left: string;
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
        gap: `${gap || "16"}px`,
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


// Padding object field reused by every block. Split so authors
// have four-side control without a bespoke UI.
const paddingField = {
  type: "object" as const,
  label: "Padding (px)",
  objectFields: {
    top: {
      type: "select" as const,
      label: "Top",
      options: SPACING_OPTIONS,
    },
    right: {
      type: "select" as const,
      label: "Right",
      options: SPACING_OPTIONS,
    },
    bottom: {
      type: "select" as const,
      label: "Bottom",
      options: SPACING_OPTIONS,
    },
    left: {
      type: "select" as const,
      label: "Left",
      options: SPACING_OPTIONS,
    },
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
          type: "select",
          label: "Max width",
          options: MAX_WIDTH_OPTIONS,
        },
        align: alignField,
      },
      defaultProps: {
        padding: { top: "48", right: "24", bottom: "48", left: "24" },
        backgroundColor: "",
        textColor: "",
        maxWidth: "1200",
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
        padding: { top: "0", right: "0", bottom: "16", left: "0" },
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
          type: "select",
          label: "Font size (px)",
          options: [
            { label: "14", value: "14" },
            { label: "16", value: "16" },
            { label: "18", value: "18" },
            { label: "20", value: "20" },
            { label: "24", value: "24" },
          ],
        },
        padding: paddingField,
      },
      defaultProps: {
        text: "",
        align: "left",
        color: "",
        fontSize: "16",
        padding: { top: "0", right: "0", bottom: "16", left: "0" },
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
          type: "select",
          label: "Max width (px)",
          options: [
            { label: "Full width", value: "" },
            { label: "400", value: "400" },
            { label: "600", value: "600" },
            { label: "800", value: "800" },
            { label: "1000", value: "1000" },
          ],
        },
        borderRadius: {
          type: "select",
          label: "Corner radius (px)",
          options: [
            { label: "None", value: "0" },
            { label: "S (4)", value: "4" },
            { label: "M (8)", value: "8" },
            { label: "L (16)", value: "16" },
            { label: "XL (24)", value: "24" },
          ],
        },
        padding: paddingField,
      },
      defaultProps: {
        src: "",
        alt: "",
        align: "center",
        maxWidth: "800",
        borderRadius: "8",
        padding: { top: "0", right: "0", bottom: "16", left: "0" },
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
        padding: { top: "16", right: "0", bottom: "16", left: "0" },
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
        padding: { top: "8", right: "0", bottom: "8", left: "0" },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      render: ButtonBlock as any,
    },
    Divider: {
      label: "Divider",
      fields: {
        color: { type: "text", label: "Color (#hex)" },
        thickness: {
          type: "select",
          label: "Thickness (px)",
          options: [
            { label: "Hairline (1)", value: "1" },
            { label: "Thin (2)", value: "2" },
            { label: "Medium (4)", value: "4" },
            { label: "Thick (8)", value: "8" },
          ],
        },
        padding: paddingField,
      },
      defaultProps: {
        color: "#e6e6e6",
        thickness: "1",
        padding: { top: "16", right: "0", bottom: "16", left: "0" },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      render: Divider as any,
    },
    Spacer: {
      label: "Spacer",
      fields: {
        height: {
          type: "select",
          label: "Height (px)",
          options: SPACING_OPTIONS.filter((o) => o.value !== "0"),
        },
      },
      defaultProps: { height: "32" },
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
        gap: {
          type: "select",
          label: "Gap (px)",
          options: SPACING_OPTIONS,
        },
        padding: paddingField,
        // Slot fields let the author drop other blocks into each
        // column. Puck renders them as drop zones on the canvas.
        left: { type: "slot", label: "Left column" },
        middle: { type: "slot", label: "Middle column" },
        right: { type: "slot", label: "Right column (3-col only)" },
      },
      defaultProps: {
        columns: 2,
        gap: "24",
        padding: { top: "16", right: "0", bottom: "16", left: "0" },
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
        padding: { top: "48", right: "24", bottom: "48", left: "24" },
        backgroundColor: "#faf8f4",
        textColor: "",
        maxWidth: "1200",
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
        padding: { top: "0", right: "0", bottom: "16", left: "0" },
      },
    },
    {
      type: "Paragraph",
      props: {
        id: "Paragraph-starter-1",
        text: "Use the sidebar on the left to drag blocks onto the canvas. Every block has its own padding, colours and layout controls — click one to see them in the right sidebar.",
        align: "center",
        color: "#404040",
        fontSize: "18",
        padding: { top: "0", right: "0", bottom: "24", left: "0" },
      },
    },
  ],
  root: { props: { title: "Product page" } },
} as const;
