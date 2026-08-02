"use client";

/**
 * Rich-text editor used for RTG catalog page bodies.
 *
 * TipTap under the hood — battle-tested React editor with a JSON /
 * HTML output. We store the HTML on the server (sanitized via
 * ``bleach`` on save) so consumers only need a plain HTML renderer
 * to display the content identically to what the author saw.
 *
 * The toolbar is deliberately minimal — bold / italic / underline /
 * strike, three heading levels, ordered + unordered lists, blockquote,
 * link, image, undo / redo. Anything the toolbar exposes here has a
 * matching entry in the server sanitizer's tag whitelist so a valid
 * click can't emit HTML the server will strip.
 */

import { useCallback, useEffect } from "react";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import {
  Bold,
  Heading1,
  Heading2,
  Heading3,
  Image as ImageIcon,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Quote,
  Redo2,
  Strikethrough,
  Underline as UnderlineIcon,
  Undo2,
} from "lucide-react";


interface Props {
  readonly value: string;
  readonly onChange: (html: string) => void;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  //: Height of the editable region. Toolbar renders on top and is
  //: not counted; content area scrolls internally when overflowed.
  readonly minHeight?: string;
}


export function RichTextEditor({
  value,
  onChange,
  placeholder = "Start writing…",
  disabled = false,
  minHeight = "16rem",
}: Props) {
  const editor = useEditor({
    // SSR hydration — Next.js renders the initial HTML on the server;
    // TipTap needs to know not to re-render immediately to avoid a
    // hydration mismatch on the editor DOM.
    immediatelyRender: false,
    editable: !disabled,
    extensions: [
      // TipTap v3 StarterKit bundles bold / italic / strike /
      // underline / link / lists / headings / blockquote / code /
      // hard-break / horizontal-rule / dropcursor / undo-redo out of
      // the box. Registering any of those separately would create
      // a duplicate extension and silently break command execution
      // (clicks land but the doc never mutates), so we only add
      // extensions StarterKit does NOT include — image + placeholder.
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
      Image.configure({
        HTMLAttributes: {
          class: "max-w-full rounded-md",
        },
      }),
      Placeholder.configure({ placeholder }),
    ],
    content: value,
    editorProps: {
      attributes: {
        // Tailwind Typography would be ideal here; scoped styling
        // works too and keeps the editor self-contained.
        class:
          "prose prose-sm max-w-none focus:outline-none px-4 py-3 " +
          "prose-headings:mt-4 prose-headings:mb-2 " +
          "prose-p:my-2 prose-ul:my-2 prose-ol:my-2",
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
    // Not depending on ``editor`` because that would fire on every
    // keystroke — we only need to react to external ``value`` swaps.
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

  return (
    <div
      role="toolbar"
      className="flex flex-wrap items-center gap-0.5 border-b border-ink-200 bg-ink-50 px-2 py-1.5"
    >
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
      <Divider />
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
        title="Quote"
        active={editor.isActive("blockquote")}
        disabled={disabled}
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
      >
        <Quote className="h-3.5 w-3.5" />
      </ToolbarButton>
      <Divider />
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
