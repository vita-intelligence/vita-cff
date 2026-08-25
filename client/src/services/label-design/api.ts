/** Raw API calls for the label-design domain.
 *
 * Thin wrappers around ``apiClient``; caching + invalidation live in
 * the corresponding TanStack hooks.
 */

import { apiClient } from "@/lib/api";
import type { RenderedSheetContext } from "@/services/specifications";

import { labelDesignEndpoints as ep } from "./endpoints";
import type {
  ComplianceContentBlockDto,
  ContentBlockTextDto,
  LabelDesignDto,
  LabelDesignListItemDto,
  LabelDesignListPage,
  LabelDesignReviewDto,
  LabelDesignTemplateCategoryDto,
  LabelDesignTemplateDto,
  LabelDesignTransitionDto,
  PortalLabelDesignTemplateGroup,
} from "./types";


// ---------------------------------------------------------------------------
// Staff
// ---------------------------------------------------------------------------


export async function fetchLabelDesigns(
  orgId: string,
  options: {
    readonly status?: string;
    readonly designer?: string;
    readonly search?: string;
    readonly limit?: number;
    readonly offset?: number;
  } = {},
): Promise<LabelDesignListPage> {
  const params = new URLSearchParams();
  if (options.status) params.set("status", options.status);
  if (options.designer) params.set("designer", options.designer);
  if (options.search) params.set("search", options.search);
  if (typeof options.limit === "number")
    params.set("limit", String(options.limit));
  if (typeof options.offset === "number")
    params.set("offset", String(options.offset));
  const qs = params.toString();
  const url = qs ? `${ep.list(orgId)}?${qs}` : ep.list(orgId);
  const { data } = await apiClient.get<LabelDesignListPage>(url);
  return data;
}


// Maintained as a small helper for one-off callers that just want an
// array of rows from a single page (current usages: nothing in app
// code — kept for parity with the previous shape so external imports
// don't break).
export async function fetchLabelDesignsFirstPage(
  orgId: string,
  options: { readonly status?: string; readonly designer?: string } = {},
): Promise<ReadonlyArray<LabelDesignListItemDto>> {
  const page = await fetchLabelDesigns(orgId, options);
  return page.items;
}


export async function fetchLabelDesign(
  orgId: string,
  ldId: string,
): Promise<LabelDesignDto> {
  const { data } = await apiClient.get<LabelDesignDto>(ep.detail(orgId, ldId));
  return data;
}


export async function fetchLabelDesignSpec(
  orgId: string,
  ldId: string,
): Promise<RenderedSheetContext> {
  const { data } = await apiClient.get<RenderedSheetContext>(
    ep.specRender(orgId, ldId),
  );
  return data;
}


export async function fetchContentBlockHtml(
  orgId: string,
  ldId: string,
): Promise<string> {
  // ``responseType: 'text'`` so axios doesn't try to parse the HTML
  // body as JSON. The endpoint returns the same template the PDF and
  // PNG renderers use, so embedding the response in an iframe gives
  // the staff a WYSIWYG preview that matches the download.
  const { data } = await apiClient.get<string>(ep.contentBlockHtml(orgId, ldId), {
    responseType: "text",
  });
  return data;
}


/** CSS selector per ``REGION_SLUGS`` value (server-side constant).
 *  ``"all"`` falls back to the entire body so the export contains
 *  the brand header + every panel + ingredients + footer. The
 *  panel class names mirror the ones in
 *  ``apps/label_design/templates/label_design/content_block.html``;
 *  changing one without the other will silently produce empty
 *  downloads. */
const REGION_SELECTORS: Record<string, string> = {
  "uk-eu": ".panel-uk-eu",
  us: ".panel-us",
  japan: ".panel-jp",
  china: ".panel-cn",
  "australia-nz": ".panel-au",
  "codex-asean": ".panel-codex",
  "gso-dubai": ".panel-gso",
  africa: ".panel-af",
};


/** Render the requested panel (or the whole document) to a canvas
 *  via html2canvas.
 *
 *  We capture in-place inside the iframe — the parent document's
 *  Tailwind stylesheets use ``lab()`` / ``oklch()`` color functions
 *  that html2canvas can't parse, so any clone-into-body approach
 *  blows up at parse time. To stop the panel grid from inflating
 *  the captured panel to the tallest sibling's row height, we
 *  patch ``align-items: start`` onto the live ``.panels-grid``
 *  before measuring and restore the original value afterwards.
 *  This works regardless of whether the iframe's HTML is the
 *  latest template or a stale cached render.
 */
async function _renderRegionToCanvas(
  iframe: HTMLIFrameElement,
  region: string,
): Promise<HTMLCanvasElement> {
  const html2canvas = (await import("html2canvas")).default;

  const doc = iframe.contentDocument;
  const win = iframe.contentWindow;
  if (!doc || !win) {
    throw new Error("Preview iframe is not ready yet — try again in a second.");
  }

  let target: HTMLElement;
  if (region === "all") {
    target = doc.body;
  } else {
    const selector = REGION_SELECTORS[region];
    const found = selector
      ? (doc.querySelector(selector) as HTMLElement | null)
      : null;
    if (!found) {
      throw new Error(`Region "${region}" not found in preview.`);
    }
    target = found;
  }

  // Patch the grid alignment so each panel sizes to its own
  // content rather than stretching to the row's tallest sibling.
  // Done as inline style so it wins regardless of what the
  // (possibly cached) stylesheet says, and restored after the
  // capture so the on-screen preview is unaffected.
  const grid = doc.querySelector(".panels-grid") as HTMLElement | null;
  const previousAlign = grid?.style.alignItems ?? "";
  if (grid) {
    grid.style.alignItems = "start";
  }
  // Re-measure after the style mutation has settled so the panel
  // reports its content height, not the stretched row height.
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

  try {
    const rect = target.getBoundingClientRect();
    return await html2canvas(target, {
      backgroundColor: "#ffffff",
      scale: 2,
      useCORS: true,
      width: rect.width,
      height: rect.height,
      windowWidth: win.innerWidth,
      windowHeight: win.innerHeight,
      scrollX: 0,
      scrollY: 0,
    });
  } finally {
    if (grid) {
      grid.style.alignItems = previousAlign;
    }
  }
}


/** Trigger a PNG download rendered straight from the preview iframe.
 *  No server round-trip — we already have the rendered HTML in the
 *  iframe, so html2canvas rasterises that and the browser saves it. */
export async function downloadContentBlockPng(
  iframe: HTMLIFrameElement,
  ldId: string,
  region: string,
): Promise<void> {
  const canvas = await _renderRegionToCanvas(iframe, region);
  const dataUrl = canvas.toDataURL("image/png");
  const suffix = region && region !== "all" ? `-${region}` : "";
  _triggerDataUrlDownload(dataUrl, `content-block-${ldId}${suffix}.png`);
}


/** Trigger a PDF download rendered from the preview iframe. We
 *  embed the html2canvas raster inside a single jsPDF page sized
 *  to match the captured canvas so the panel fills the page with
 *  no whitespace. Vector PDF would mean re-implementing the layout
 *  via jsPDF primitives; the raster path keeps the visual identical
 *  to what the staff already see on screen. */
export async function downloadContentBlockPdf(
  iframe: HTMLIFrameElement,
  ldId: string,
  region: string,
): Promise<void> {
  const { default: jsPDF } = await import("jspdf");
  const canvas = await _renderRegionToCanvas(iframe, region);
  const imgData = canvas.toDataURL("image/png");

  // Canvas is at scale=2 so divide back to "logical" px for the
  // PDF page dimensions; convert CSS pixels (96 DPI) into PDF
  // points (72 DPI) which is jsPDF's most reliable unit — the
  // ``px`` mode silently rounds with the wrong DPR on some builds
  // and was leaving a fat margin on the right of single-panel
  // exports. Express both the page format AND the addImage
  // dimensions in the same unit so the image fills edge-to-edge.
  const pxToPt = (px: number) => (px * 72) / 96;
  const pageWPt = pxToPt(canvas.width / 2);
  const pageHPt = pxToPt(canvas.height / 2);
  const pdf = new jsPDF({
    orientation: pageWPt > pageHPt ? "landscape" : "portrait",
    unit: "pt",
    format: [pageWPt, pageHPt],
    compress: true,
  });
  pdf.addImage(imgData, "PNG", 0, 0, pageWPt, pageHPt);
  const suffix = region && region !== "all" ? `-${region}` : "";
  pdf.save(`content-block-${ldId}${suffix}.pdf`);
}


function _triggerDataUrlDownload(dataUrl: string, filename: string): void {
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}


export async function assignLabelDesigner(
  orgId: string,
  ldId: string,
  designerId: string | null,
): Promise<LabelDesignDto> {
  const { data } = await apiClient.post<LabelDesignDto>(
    ep.assignDesigner(orgId, ldId),
    { designer_id: designerId },
  );
  return data;
}


export async function uploadLabelArtwork(
  orgId: string,
  ldId: string,
  payload: {
    readonly artwork: File;
    readonly notes?: string;
    /** Optional companion files — "back", "side", "mockup" views
     *  that ride alongside the primary artwork on the same revision.
     *  Order + labels persist through to the read serializer. */
    readonly additionalFiles?: ReadonlyArray<{
      readonly file: File;
      readonly label: string;
    }>;
  },
): Promise<LabelDesignDto> {
  const form = new FormData();
  form.append("artwork", payload.artwork);
  if (payload.notes) form.append("notes", payload.notes);
  const extras = payload.additionalFiles ?? [];
  for (const extra of extras) form.append("additional_files", extra.file);
  form.append(
    "additional_file_labels",
    JSON.stringify(extras.map((e) => e.label.trim())),
  );
  const { data } = await apiClient.post<LabelDesignDto>(
    ep.uploadArtwork(orgId, ldId),
    form,
  );
  return data;
}


export async function submitLabelForReview(
  orgId: string,
  ldId: string,
): Promise<LabelDesignDto> {
  const { data } = await apiClient.post<LabelDesignDto>(
    ep.submitForReview(orgId, ldId),
    {},
  );
  return data;
}


export interface ReviewSubmitBody {
  readonly outcome: "approved" | "requires_revision";
  readonly checklist: ReadonlyArray<{
    readonly item_key: string;
    readonly pass_check: boolean;
    readonly comment: string;
  }>;
  readonly final_comments: string;
  readonly signature_image?: string;
}


export async function submitScientistReview(
  orgId: string,
  ldId: string,
  body: ReviewSubmitBody,
): Promise<LabelDesignDto> {
  const { data } = await apiClient.post<LabelDesignDto>(
    ep.scientistReview(orgId, ldId),
    body,
  );
  return data;
}


export async function submitDirectorReview(
  orgId: string,
  ldId: string,
  body: ReviewSubmitBody,
): Promise<LabelDesignDto> {
  const { data } = await apiClient.post<LabelDesignDto>(
    ep.directorReview(orgId, ldId),
    body,
  );
  return data;
}


export async function holdLabelDesign(
  orgId: string,
  ldId: string,
  notes: string,
): Promise<LabelDesignDto> {
  const { data } = await apiClient.post<LabelDesignDto>(
    ep.hold(orgId, ldId),
    { notes },
  );
  return data;
}


export async function resumeLabelDesign(
  orgId: string,
  ldId: string,
  notes: string,
): Promise<LabelDesignDto> {
  const { data } = await apiClient.post<LabelDesignDto>(
    ep.resume(orgId, ldId),
    { notes },
  );
  return data;
}


export async function fetchLabelDesignTransitions(
  orgId: string,
  ldId: string,
): Promise<ReadonlyArray<LabelDesignTransitionDto>> {
  const { data } = await apiClient.get<{ items: LabelDesignTransitionDto[] }>(
    ep.transitions(orgId, ldId),
  );
  return data.items;
}


export async function fetchLabelDesignReviews(
  orgId: string,
  ldId: string,
): Promise<ReadonlyArray<LabelDesignReviewDto>> {
  const { data } = await apiClient.get<{ items: LabelDesignReviewDto[] }>(
    ep.reviews(orgId, ldId),
  );
  return data.items;
}


export async function fetchContentBlockJson(
  orgId: string,
  ldId: string,
): Promise<ComplianceContentBlockDto> {
  const { data } = await apiClient.get<ComplianceContentBlockDto>(
    ep.contentBlockJson(orgId, ldId),
  );
  return data;
}


export async function fetchContentBlockText(
  orgId: string,
  ldId: string,
): Promise<ContentBlockTextDto> {
  const { data } = await apiClient.get<ContentBlockTextDto>(
    ep.contentBlockText(orgId, ldId),
  );
  return data;
}


// ---------------------------------------------------------------------------
// Portal (no orgId — the cookie-bound ClientAccount scopes ownership)
// ---------------------------------------------------------------------------


export async function portalFetchLabelDesigns(): Promise<
  ReadonlyArray<LabelDesignDto>
> {
  const { data } = await apiClient.get<{ items: LabelDesignDto[] }>(
    ep.portalList(),
  );
  return data.items;
}


export async function portalFetchLabelDesign(
  ldId: string,
): Promise<LabelDesignDto> {
  const { data } = await apiClient.get<LabelDesignDto>(ep.portalDetail(ldId));
  return data;
}


export async function portalChoosePath(
  ldId: string,
  path: "design_by_us" | "design_by_customer",
): Promise<LabelDesignDto> {
  const { data } = await apiClient.post<LabelDesignDto>(
    ep.portalChoosePath(ldId),
    { path },
  );
  return data;
}


export interface PreferencesSubmitBody {
  readonly company_name?: string;
  readonly brand_name?: string;
  readonly product_names?: string;
  readonly product_codes?: string;
  readonly brand_colours?: ReadonlyArray<{ name: string; hex: string }>;
  readonly inspiration_urls?: ReadonlyArray<string>;
  readonly elements_to_include?: string;
  readonly design_style?: string;
  readonly material_type?: string;
  readonly additional_comments?: string;
  readonly declaration_name?: string;
  readonly declaration_position?: string;
  readonly declaration_signature_image?: string;
}


export async function portalSubmitPreferences(
  ldId: string,
  body: PreferencesSubmitBody,
  inspirationFiles: ReadonlyArray<File> = [],
): Promise<LabelDesignDto> {
  const form = new FormData();
  Object.entries(body).forEach(([key, value]) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      form.append(key, JSON.stringify(value));
    } else {
      form.append(key, String(value));
    }
  });
  for (const file of inspirationFiles) {
    form.append("inspiration_files", file);
  }
  const { data } = await apiClient.post<LabelDesignDto>(
    ep.portalPreferences(ldId),
    form,
  );
  return data;
}


export async function portalFetchContentBlockJson(
  ldId: string,
): Promise<ComplianceContentBlockDto> {
  const { data } = await apiClient.get<ComplianceContentBlockDto>(
    ep.portalContentBlockJson(ldId),
  );
  return data;
}


export async function portalFetchContentBlockText(
  ldId: string,
): Promise<ContentBlockTextDto> {
  const { data } = await apiClient.get<ContentBlockTextDto>(
    ep.portalContentBlockText(ldId),
  );
  return data;
}


export async function portalFetchContentBlockHtml(
  ldId: string,
): Promise<string> {
  const { data } = await apiClient.get<string>(
    ep.portalContentBlockHtml(ldId),
    { responseType: "text" },
  );
  return data;
}


export async function portalUploadArtwork(
  ldId: string,
  payload: {
    readonly artwork: File;
    readonly signature_image: string;
    readonly notes?: string;
  },
): Promise<LabelDesignDto> {
  const form = new FormData();
  form.append("artwork", payload.artwork);
  form.append("signature_image", payload.signature_image);
  if (payload.notes) form.append("notes", payload.notes);
  const { data } = await apiClient.post<LabelDesignDto>(
    ep.portalUploadArtwork(ldId),
    form,
  );
  return data;
}


export async function portalApproveLabel(
  ldId: string,
  signature_image: string,
): Promise<LabelDesignDto> {
  const { data } = await apiClient.post<LabelDesignDto>(
    ep.portalApprove(ldId),
    { signature_image },
  );
  return data;
}


export async function portalRejectLabel(
  ldId: string,
  reason: string,
): Promise<LabelDesignDto> {
  const { data } = await apiClient.post<LabelDesignDto>(
    ep.portalReject(ldId),
    { reason },
  );
  return data;
}


// ---------------------------------------------------------------------------
// Template library (staff)
// ---------------------------------------------------------------------------


export async function fetchLabelDesignTemplateCategories(
  orgId: string,
): Promise<LabelDesignTemplateCategoryDto[]> {
  const { data } = await apiClient.get<{
    items: LabelDesignTemplateCategoryDto[];
  }>(ep.templateCategories(orgId));
  return data.items;
}


export async function createLabelDesignTemplateCategory(
  orgId: string,
  payload: {
    name: string;
    description?: string;
    sort_order?: number;
  },
): Promise<LabelDesignTemplateCategoryDto> {
  const { data } = await apiClient.post<LabelDesignTemplateCategoryDto>(
    ep.templateCategories(orgId),
    payload,
  );
  return data;
}


export async function updateLabelDesignTemplateCategory(
  orgId: string,
  catId: string,
  payload: Partial<{
    name: string;
    description: string;
    sort_order: number;
  }>,
): Promise<LabelDesignTemplateCategoryDto> {
  const { data } = await apiClient.patch<LabelDesignTemplateCategoryDto>(
    ep.templateCategoryDetail(orgId, catId),
    payload,
  );
  return data;
}


export async function deleteLabelDesignTemplateCategory(
  orgId: string,
  catId: string,
): Promise<void> {
  await apiClient.delete(ep.templateCategoryDetail(orgId, catId));
}


export async function fetchLabelDesignTemplates(
  orgId: string,
): Promise<LabelDesignTemplateDto[]> {
  const { data } = await apiClient.get<{ items: LabelDesignTemplateDto[] }>(
    ep.templates(orgId),
  );
  return data.items;
}


export async function uploadLabelDesignTemplate(
  orgId: string,
  payload: {
    category_id: string;
    name: string;
    description?: string;
    file: File;
    sort_order?: number;
  },
): Promise<LabelDesignTemplateDto> {
  const form = new FormData();
  form.append("category_id", payload.category_id);
  form.append("name", payload.name);
  if (payload.description) form.append("description", payload.description);
  form.append("file", payload.file);
  if (payload.sort_order !== undefined) {
    form.append("sort_order", String(payload.sort_order));
  }
  const { data } = await apiClient.post<LabelDesignTemplateDto>(
    ep.templates(orgId),
    form,
  );
  return data;
}


export async function updateLabelDesignTemplate(
  orgId: string,
  tplId: string,
  payload: Partial<{
    name: string;
    description: string;
    sort_order: number;
    category_id: string;
  }>,
): Promise<LabelDesignTemplateDto> {
  const { data } = await apiClient.patch<LabelDesignTemplateDto>(
    ep.templateDetail(orgId, tplId),
    payload,
  );
  return data;
}


export async function deleteLabelDesignTemplate(
  orgId: string,
  tplId: string,
): Promise<void> {
  await apiClient.delete(ep.templateDetail(orgId, tplId));
}


// ---------------------------------------------------------------------------
// Portal template library (read-only)
// ---------------------------------------------------------------------------


export async function fetchPortalLabelDesignTemplates(): Promise<
  PortalLabelDesignTemplateGroup[]
> {
  const { data } = await apiClient.get<{
    items: PortalLabelDesignTemplateGroup[];
  }>(ep.portalTemplateLibrary());
  return data.items;
}
