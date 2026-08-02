"use client";

/**
 * Rich-text editor used for RTG catalog page bodies.
 *
 * TipTap v3 under the hood — battle-tested React editor with a JSON /
 * HTML output. We store the HTML on the server (sanitized via
 * ``bleach`` on save) so consumers only need a plain HTML renderer
 * to display the content identically to what the author saw.
 *
 * Feature surface:
 * - Marks: bold, italic, underline, strike, superscript, subscript,
 *   text color, highlight
 * - Blocks: paragraphs, H1-H3, bullet / ordered / task lists,
 *   blockquote, horizontal rule
 * - Alignment: left / center / right / justify
 * - Media: link, image (URL), YouTube embed
 * - Tables: insert, add/remove row + column, header row,
 *   drag-to-resize columns
 * - Character count in the footer
 *
 * Every tag the toolbar can produce is on the server's bleach
 * whitelist. Adding a new extension here means adding its emitted
 * tags to ``_RTG_LONG_DESCRIPTION_TAGS`` server-side too.
 */

import { useCallback, useEffect } from "react";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import { TextStyle } from "@tiptap/extension-text-style";
import Color from "@tiptap/extension-color";
import Highlight from "@tiptap/extension-highlight";
import Superscript from "@tiptap/extension-superscript";
import Subscript from "@tiptap/extension-subscript";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import TextAlign from "@tiptap/extension-text-align";
import Youtube from "@tiptap/extension-youtube";
import CharacterCount from "@tiptap/extension-character-count";
import { TableKit } from "@tiptap/extension-table";
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Bold,
  CheckSquare,
  Columns3,
  Heading1,
  Heading2,
  Heading3,
  Highlighter,
  Image as ImageIcon,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Minus,
  Palette,
  Quote,
  Redo2,
  Rows3,
  Strikethrough,
  Subscript as SubIcon,
  Superscript as SupIcon,
  Table as TableIcon,
  Trash2,
  Underline as UnderlineIcon,
  Undo2,
  Film as YoutubeIcon,
} from "lucide-react";


interface Props {
  readonly value: string;
  readonly onChange: (html: string) => void;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  //: Height of the editable region. Toolbar + footer render around
  //: it; content area scrolls internally when overflowed.
  readonly minHeight?: string;
  //: Soft cap surfaced in the footer counter. Content past this is
  //: still accepted — the number turns red to nudge the author.
  readonly softCharLimit?: number;
}


export function RichTextEditor({
  value,
  onChange,
  placeholder = "Start writing…",
  disabled = false,
  minHeight = "18rem",
  softCharLimit = 8000,
}: Props) {
  const editor = useEditor({
    // SSR hydration — Next.js renders the initial HTML on the server;
    // TipTap needs to know not to re-render immediately to avoid a
    // hydration mismatch on the editor DOM.
    immediatelyRender: false,
    editable: !disabled,
    extensions: [
      // StarterKit already ships bold / italic / strike / underline /
      // link / lists / heading / blockquote / code / hard-break /
      // horizontal-rule / dropcursor / gapcursor / undo-redo /
      // paragraph / text. Registering any of those separately would
      // create a duplicate ProseMirror plugin and silently no-op
      // command execution.
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        link: {
          openOnClick: false,
          HTMLAttributes: {
            rel: "noopener noreferrer",
            target: "_blank",
          },
        },
      }),
      // TextStyle is a prerequisite for Color — Color adds a
      // ``color`` attribute onto TextStyle marks. Highlight is
      // independent; ``multicolor`` lets us pass a hex through the
      // toolbar picker.
      TextStyle,
      Color,
      Highlight.configure({ multicolor: true }),
      Superscript,
      Subscript,
      TaskList,
      TaskItem.configure({ nested: true }),
      TextAlign.configure({
        types: ["heading", "paragraph"],
        alignments: ["left", "center", "right", "justify"],
      }),
      Image.configure({
        HTMLAttributes: { class: "max-w-full rounded-md" },
      }),
      Youtube.configure({
        // Keep the responsive container so the embed adapts to the
        // catalog card width. ``controls`` on so shoppers can seek /
        // mute; ``nocookie`` for a lighter GDPR footprint.
        controls: true,
        nocookie: true,
        HTMLAttributes: { class: "aspect-video w-full rounded-md" },
      }),
      TableKit.configure({
        table: { resizable: true },
      }),
      CharacterCount,
      Placeholder.configure({ placeholder }),
    ],
    content: value,
    editorProps: {
      attributes: {
        // ``rich-content`` matches the scoped styles in globals.css.
        // We deliberately don't use ``prose`` (Tailwind Typography)
        // because the plugin isn't installed — without it Preflight
        // strips bold / italic / list defaults and the editor looks
        // broken even though TipTap emits correct markup.
        class: "rich-content ProseMirror",
      },
    },
    onUpdate: ({ editor }) => {
      onChange(editor.getHTML());
    },
  });

  // Keep the editor in sync when the parent hydrates the initial
  // value asynchronously (e.g. SSR passes empty then a fetch fills
  // it). Skip when the incoming value already matches to avoid
  // resetting the cursor while the user is typing.
  useEffect(() => {
    if (!editor) return;
    const current = editor.getHTML();
    if (value !== current) {
      editor.commands.setContent(value || "", { emitUpdate: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  useEffect(() => {
    if (!editor) return;
    editor.setEditable(!disabled);
  }, [editor, disabled]);

  if (!editor) {
    return (
      <div
        className="w-full rounded-lg border border-ink-300 bg-ink-50 p-4 text-sm text-ink-500"
        style={{ minHeight }}
      >
        Loading editor…
      </div>
    );
  }

  return (
    <div className="flex flex-col rounded-lg border border-ink-300 bg-white shadow-sm">
      <Toolbar editor={editor} disabled={disabled} />
      <div
        className="overflow-y-auto"
        style={{ minHeight, maxHeight: "32rem" }}
      >
        <EditorContent editor={editor} />
      </div>
      <Footer editor={editor} softLimit={softCharLimit} />
    </div>
  );
}


// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------


function Toolbar({ editor, disabled }: { editor: Editor; disabled: boolean }) {
  const promptLink = useCallback(() => {
    const existing = editor.getAttributes("link").href as string | undefined;
    const url = window.prompt("Link URL", existing || "https://");
    if (url === null) return;
    if (url === "") {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
  }, [editor]);

  const promptImage = useCallback(() => {
    const url = window.prompt("Image URL");
    if (!url) return;
    editor.chain().focus().setImage({ src: url }).run();
  }, [editor]);

  const promptYoutube = useCallback(() => {
    const url = window.prompt(
      "YouTube URL (paste the full watch link)",
      "https://www.youtube.com/watch?v=",
    );
    if (!url) return;
    editor.commands.setYoutubeVideo({ src: url });
  }, [editor]);

  const promptColor = useCallback(() => {
    const current = editor.getAttributes("textStyle").color as
      | string
      | undefined;
    const value = window.prompt("Text color (#hex)", current || "#c2410c");
    if (value === null) return;
    if (value === "") {
      editor.chain().focus().unsetColor().run();
      return;
    }
    editor.chain().focus().setColor(value).run();
  }, [editor]);

  const promptHighlight = useCallback(() => {
    const current = editor.getAttributes("highlight").color as
      | string
      | undefined;
    const value = window.prompt(
      "Highlight color (#hex)",
      current || "#fef08a",
    );
    if (value === null) return;
    if (value === "") {
      editor.chain().focus().unsetHighlight().run();
      return;
    }
    editor.chain().focus().toggleHighlight({ color: value }).run();
  }, [editor]);

  const insertTable = useCallback(() => {
    editor
      .chain()
      .focus()
      .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
      .run();
  }, [editor]);

  const inTable = editor.isActive("table");

  return (
    <div
      role="toolbar"
      className="flex flex-wrap items-center gap-0.5 border-b border-ink-200 bg-ink-50 px-2 py-1.5"
    >
      {/* Text marks */}
      <ToolbarButton
        title="Bold"
        active={editor.isActive("bold")}
        disabled={disabled}
        onClick={() => editor.chain().focus().toggleBold().run()}
      >
        <Bold className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        title="Italic"
        active={editor.isActive("italic")}
        disabled={disabled}
        onClick={() => editor.chain().focus().toggleItalic().run()}
      >
        <Italic className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        title="Underline"
        active={editor.isActive("underline")}
        disabled={disabled}
        onClick={() => editor.chain().focus().toggleUnderline().run()}
      >
        <UnderlineIcon className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        title="Strikethrough"
        active={editor.isActive("strike")}
        disabled={disabled}
        onClick={() => editor.chain().focus().toggleStrike().run()}
      >
        <Strikethrough className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        title="Superscript (H₂O, mg²)"
        active={editor.isActive("superscript")}
        disabled={disabled}
        onClick={() => editor.chain().focus().toggleSuperscript().run()}
      >
        <SupIcon className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        title="Subscript"
        active={editor.isActive("subscript")}
        disabled={disabled}
        onClick={() => editor.chain().focus().toggleSubscript().run()}
      >
        <SubIcon className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        title="Text color"
        active={!!editor.getAttributes("textStyle").color}
        disabled={disabled}
        onClick={promptColor}
      >
        <Palette className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        title="Highlight"
        active={editor.isActive("highlight")}
        disabled={disabled}
        onClick={promptHighlight}
      >
        <Highlighter className="h-3.5 w-3.5" />
      </ToolbarButton>

      <Divider />

      {/* Block structure */}
      <ToolbarButton
        title="Heading 1"
        active={editor.isActive("heading", { level: 1 })}
        disabled={disabled}
        onClick={() =>
          editor.chain().focus().toggleHeading({ level: 1 }).run()
        }
      >
        <Heading1 className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        title="Heading 2"
        active={editor.isActive("heading", { level: 2 })}
        disabled={disabled}
        onClick={() =>
          editor.chain().focus().toggleHeading({ level: 2 }).run()
        }
      >
        <Heading2 className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        title="Heading 3"
        active={editor.isActive("heading", { level: 3 })}
        disabled={disabled}
        onClick={() =>
          editor.chain().focus().toggleHeading({ level: 3 }).run()
        }
      >
        <Heading3 className="h-3.5 w-3.5" />
      </ToolbarButton>

      <Divider />

      {/* Lists + quote + rule */}
      <ToolbarButton
        title="Bulleted list"
        active={editor.isActive("bulletList")}
        disabled={disabled}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
      >
        <List className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        title="Numbered list"
        active={editor.isActive("orderedList")}
        disabled={disabled}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
      >
        <ListOrdered className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        title="Task list (checkboxes)"
        active={editor.isActive("taskList")}
        disabled={disabled}
        onClick={() => editor.chain().focus().toggleTaskList().run()}
      >
        <CheckSquare className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        title="Quote"
        active={editor.isActive("blockquote")}
        disabled={disabled}
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
      >
        <Quote className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        title="Horizontal rule"
        active={false}
        disabled={disabled}
        onClick={() => editor.chain().focus().setHorizontalRule().run()}
      >
        <Minus className="h-3.5 w-3.5" />
      </ToolbarButton>

      <Divider />

      {/* Alignment */}
      <ToolbarButton
        title="Align left"
        active={editor.isActive({ textAlign: "left" })}
        disabled={disabled}
        onClick={() => editor.chain().focus().setTextAlign("left").run()}
      >
        <AlignLeft className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        title="Align center"
        active={editor.isActive({ textAlign: "center" })}
        disabled={disabled}
        onClick={() => editor.chain().focus().setTextAlign("center").run()}
      >
        <AlignCenter className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        title="Align right"
        active={editor.isActive({ textAlign: "right" })}
        disabled={disabled}
        onClick={() => editor.chain().focus().setTextAlign("right").run()}
      >
        <AlignRight className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        title="Justify"
        active={editor.isActive({ textAlign: "justify" })}
        disabled={disabled}
        onClick={() => editor.chain().focus().setTextAlign("justify").run()}
      >
        <AlignJustify className="h-3.5 w-3.5" />
      </ToolbarButton>

      <Divider />

      {/* Media + tables */}
      <ToolbarButton
        title="Link"
        active={editor.isActive("link")}
        disabled={disabled}
        onClick={promptLink}
      >
        <LinkIcon className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        title="Image"
        active={false}
        disabled={disabled}
        onClick={promptImage}
      >
        <ImageIcon className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        title="YouTube video"
        active={false}
        disabled={disabled}
        onClick={promptYoutube}
      >
        <YoutubeIcon className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        title="Insert table (3 × 3 with header row)"
        active={inTable}
        disabled={disabled}
        onClick={insertTable}
      >
        <TableIcon className="h-3.5 w-3.5" />
      </ToolbarButton>

      {/* Contextual table controls — only surface when the caret sits
          inside a table so the toolbar isn't cluttered otherwise. */}
      {inTable ? (
        <>
          <ToolbarButton
            title="Add column"
            active={false}
            disabled={disabled}
            onClick={() => editor.chain().focus().addColumnAfter().run()}
          >
            <Columns3 className="h-3.5 w-3.5" />
          </ToolbarButton>
          <ToolbarButton
            title="Add row"
            active={false}
            disabled={disabled}
            onClick={() => editor.chain().focus().addRowAfter().run()}
          >
            <Rows3 className="h-3.5 w-3.5" />
          </ToolbarButton>
          <ToolbarButton
            title="Delete table"
            active={false}
            disabled={disabled}
            onClick={() => editor.chain().focus().deleteTable().run()}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </ToolbarButton>
        </>
      ) : null}

      {/* Undo / redo pinned to the right so authors can always find
          them regardless of how wide the toolbar has grown. */}
      <div className="ml-auto flex items-center gap-0.5">
        <ToolbarButton
          title="Undo"
          active={false}
          disabled={disabled || !editor.can().undo()}
          onClick={() => editor.chain().focus().undo().run()}
        >
          <Undo2 className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton
          title="Redo"
          active={false}
          disabled={disabled || !editor.can().redo()}
          onClick={() => editor.chain().focus().redo().run()}
        >
          <Redo2 className="h-3.5 w-3.5" />
        </ToolbarButton>
      </div>
    </div>
  );
}


// ---------------------------------------------------------------------------
// Footer
// ---------------------------------------------------------------------------


function Footer({
  editor,
  softLimit,
}: {
  editor: Editor;
  softLimit: number;
}) {
  const chars = editor.storage.characterCount?.characters?.() ?? 0;
  const words = editor.storage.characterCount?.words?.() ?? 0;
  const over = chars > softLimit;
  return (
    <div className="flex items-center justify-between gap-3 border-t border-ink-200 bg-ink-50/60 px-3 py-1.5 text-[11px] text-ink-500">
      <span>{words} words</span>
      <span className={over ? "font-semibold text-rose-600" : ""}>
        {chars} / {softLimit} characters
      </span>
    </div>
  );
}


function ToolbarButton({
  title,
  active,
  disabled,
  onClick,
  children,
}: {
  title: string;
  active: boolean;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        active
          ? "bg-ink-1000 text-ink-0"
          : "text-ink-700 hover:bg-ink-100 hover:text-ink-1000"
      }`}
    >
      {children}
    </button>
  );
}


function Divider() {
  return <span className="mx-0.5 h-4 w-px bg-ink-200" aria-hidden />;
}
