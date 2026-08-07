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

import { ColorField } from "./color-field";
import { NumberField } from "./number-field";
import { RichTextField } from "./rich-text-field";
import {
  ResponsivePaddingField,
  normalizeResponsivePadding,
  type ResponsivePadding,
} from "./responsive-padding-field";


// Small helper: build a Puck ``custom`` field bound to our
// clearable NumberField component. ``min`` is only a soft clamp
// applied on blur so a user can freely delete every digit while
// typing (which the native ``<input type="number">`` refuses to
// let them do).
function pxField(label: string, min: number = 0) {
  return {
    type: "custom" as const,
    label,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    render: ((props: any) => (
      <NumberField
        value={props.value}
        onChange={props.onChange}
        readOnly={props.readOnly}
        min={min}
      />
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    )) as any,
  };
}


// Colour picker (swatch palette + native picker + hex input) so
// authors don't have to know hex codes to change backgrounds / text
// / dividers. Empty state = no override.
function colorField(label: string) {
  return {
    type: "custom" as const,
    label,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    render: ((props: any) => (
      <ColorField
        value={props.value}
        onChange={props.onChange}
        readOnly={props.readOnly}
      />
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    )) as any,
  };
}


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

// Emit padding as CSS custom properties keyed by breakpoint. The
// rules in ``globals.css`` (search for ``.pb-block``) resolve those
// vars inside ``@container`` queries, so a block set to 48px top
// padding on desktop and 16px on mobile actually renders that way
// when the viewport toggle constrains the preview width — no iframe
// needed. Legacy flat padding values are lifted to ``mobile`` by
// ``normalizeResponsivePadding``.
function paddingStyle(
  padding: unknown,
): CSSProperties {
  const norm = normalizeResponsivePadding(padding);
  const style: Record<string, string> = {};
  const write = (
    bp: "mobile" | "tablet" | "desktop",
    set: ResponsivePadding["mobile"] | undefined,
  ) => {
    if (!set) return;
    (["top", "right", "bottom", "left"] as const).forEach((side) => {
      const px = toPx(set[side]);
      if (px !== undefined) {
        style[`--pad-${side[0]}-${bp}`] = px;
      }
    });
  };
  write("mobile", norm.mobile);
  write("tablet", norm.tablet);
  write("desktop", norm.desktop);
  return style as CSSProperties;
}


// ---------------------------------------------------------------------------
// Block components + configs
// ---------------------------------------------------------------------------


// Puck v0.22 delivers ``type: "slot"`` fields to the render function
// as a React COMPONENT (a function), not a rendered React node.
// ``renderSlot`` handles both shapes so components stay
// forward/backward compatible: earlier Puck versions passed a
// ``ReactNode`` directly, current Puck passes a component to invoke.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderSlot(value: any): ReactNode {
  if (value == null) return null;
  if (typeof value === "function") {
    const SlotComponent = value;
    return <SlotComponent />;
  }
  return value as ReactNode;
}


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
  // Puck fills ``content`` from the ``type: "slot"`` field declared
  // below. In v0.22 the value is a React component (a function) that
  // must be invoked as ``<Content />`` — see ``renderSlot`` above.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  content?: any;
  // Legacy — early prototypes referenced ``children``. Kept in the
  // type so a stray older render call doesn't blow up.
  children?: ReactNode;
}

function Section({
  padding,
  backgroundColor,
  textColor,
  maxWidth,
  align,
  content,
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
        className="pb-block"
        style={{
          ...paddingStyle(padding),
          margin: "0 auto",
          maxWidth: capped === "0px" ? undefined : capped,
        }}
      >
        {/* ``content`` is Puck's slot fill (a component in v0.22),
            ``children`` is the legacy React node. renderSlot handles
            both shapes safely. */}
        {content != null ? renderSlot(content) : children}
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
    <div className="pb-block" style={paddingStyle(padding)}>
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
  // Puck v0.22 stores rich HTML on ``html``; ``text`` is a legacy
  // fallback for any block created before we swapped to the TipTap
  // inline editor. Legacy plain-text renders wrapped in a <p>.
  html?: string;
  text?: string;
  align: "left" | "center" | "right";
  color: string;
  padding: {
    top: number | string;
    right: number | string;
    bottom: number | string;
    left: number | string;
  };
}

function Paragraph({
  html,
  text,
  align,
  color,
  padding,
}: ParagraphProps) {
  // Prefer the new HTML value; fall back to any legacy plain text.
  const body = html && html.trim() ? html : text
    ? `<p>${text.replace(/</g, "&lt;")}</p>`
    : '<p style="color:#999">Type here — click the toolbar in the sidebar to format.</p>';
  return (
    <div
      className="rich-content pb-block"
      style={{
        ...paddingStyle(padding),
        color: color || undefined,
        textAlign: align,
      }}
      dangerouslySetInnerHTML={{ __html: body }}
    />
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
        className="pb-block text-sm text-neutral-400"
      >
        [Image placeholder — paste an image URL in the sidebar]
      </div>
    );
  }
  return (
    <div className="pb-block" style={{ ...paddingStyle(padding), ...alignStyle }}>
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
        className="pb-block text-sm text-neutral-400"
      >
        [Video placeholder — paste a YouTube watch URL in the sidebar]
      </div>
    );
  }
  return (
    <div className="pb-block" style={paddingStyle(padding)}>
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
    <div className="pb-block" style={{ ...paddingStyle(padding), ...alignStyle }}>
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
    <div className="pb-block" style={paddingStyle(padding)}>
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
  // Puck v0.22 delivers slot fields as components — accept anything
  // and let ``renderSlot`` decide how to render.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  left: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  middle: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  right: any;
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
      <div>{renderSlot(left)}</div>
      <div>{renderSlot(middle)}</div>
      {cols === 3 ? <div>{renderSlot(right)}</div> : null}
    </div>
  );
}


// ---------------------------------------------------------------------------
// Shared field definitions
// ---------------------------------------------------------------------------


// Padding field — responsive (mobile / tablet / desktop tabs).
// Value shape is normalized on read so existing flat-shape blocks
// keep working; see ``responsive-padding-field.tsx``. The block
// render function turns the value into CSS custom properties that
// ``globals.css`` resolves via ``@container`` queries, so a mobile
// vs desktop padding difference actually shows in the preview when
// the viewport toggle constrains the canvas width.
const paddingField = {
  type: "custom" as const,
  label: "Padding (per breakpoint, px)",
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  render: ((props: any) => (
    <ResponsivePaddingField
      value={props.value}
      onChange={props.onChange}
      readOnly={props.readOnly}
    />
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  )) as any,
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
      // ``Paragraph`` is the rich-text block — labelled "Rich text"
      // in the drawer so authors know it accepts formatting, not
      // just plain paragraphs.
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
        backgroundColor: colorField("Background"),
        textColor: colorField("Text color"),
        maxWidth: pxField("Max width (px, 0 = full)"),
        align: alignField,
        // Drop zone — authors drag Headings / Paragraphs / Columns /
        // etc. into the section. Puck renders the fill through the
        // ``content`` render prop above.
        content: { type: "slot", label: "Section content" },
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
        color: colorField("Color"),
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
      label: "Rich text",
      fields: {
        // ``custom`` render pipes our TipTap editor into the Puck
        // sidebar so authors can format the block's content
        // inline (bold, headings, lists, tables, colors — the works).
        html: {
          type: "custom",
          label: "Content",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          render: RichTextField as any,
        },
        align: alignField,
        color: colorField("Default text color"),
        padding: paddingField,
      },
      defaultProps: {
        html: "",
        align: "left",
        color: "",
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
        maxWidth: pxField("Max width (px, 0 = full)"),
        borderRadius: pxField("Corner radius (px)"),
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
        color: colorField("Color"),
        thickness: pxField("Thickness (px)", 1),
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
        height: pxField("Height (px)", 1),
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
        gap: pxField("Gap (px)"),
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
        html: "<p>Use the sidebar on the left to drag blocks onto the canvas. Click a block to edit it in the right sidebar — the <strong>Rich text</strong> block ships with a full formatting toolbar (bold, headings, lists, tables, links, colours, and more).</p>",
        align: "center",
        color: "#404040",
        padding: { top: 0, right: 0, bottom: 24, left: 0 },
      },
    },
  ],
  root: { props: { title: "Product page" } },
} as const;
