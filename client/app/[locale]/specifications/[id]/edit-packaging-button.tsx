"use client";

import { Button, ComboBox, ListBox, Modal } from "@heroui/react";
import { Package } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Key } from "react-aria-components";
import { Input } from "react-aria-components";

import { useRouter } from "@/i18n/navigation";
import { ApiError } from "@/lib/api";
import { translateCode } from "@/lib/errors/translate";
import { useDebouncedValue } from "@/lib/utils";
import {
  PACKAGING_DETAIL_KEYS,
  PACKAGING_SLOTS,
  usePackagingOptions,
  useSetSpecificationPackaging,
  type PackagingOption,
  type PackagingSlot,
  type SetPackagingRequestDto,
  type SpecificationSheetDto,
} from "@/services/specifications";


/**
 * Modal trigger for the spec sheet's four packaging slots.
 *
 * Each slot has its own HeroUI ComboBox backed by a debounced
 * server-side search — the catalogue is size-unbounded so the
 * client never asks for "everything". The preselected label is
 * sourced from ``sheet.packaging_details`` so the dropdown paints
 * with the right caption before the first async query resolves.
 */
export function EditPackagingButton({
  orgId,
  sheet,
}: {
  orgId: string;
  sheet: SpecificationSheetDto;
}) {
  const tSpecs = useTranslations("specifications");
  const tErrors = useTranslations("errors");
  const router = useRouter();

  const [isOpen, setIsOpen] = useState(false);
  const [selections, setSelections] = useState<SetPackagingRequestDto>({});
  const [error, setError] = useState<string | null>(null);

  const mutation = useSetSpecificationPackaging(orgId, sheet.id);

  // Reset form state whenever the modal opens or the underlying
  // sheet changes so the dropdowns reflect the latest server truth.
  useEffect(() => {
    if (!isOpen) return;
    setSelections({
      packaging_lid: sheet.packaging_lid,
      packaging_container: sheet.packaging_container,
      packaging_label: sheet.packaging_label,
      packaging_antitemper: sheet.packaging_antitemper,
    });
    setError(null);
  }, [
    isOpen,
    sheet.packaging_lid,
    sheet.packaging_container,
    sheet.packaging_label,
    sheet.packaging_antitemper,
  ]);

  const handleSelect = useCallback(
    (slot: PackagingSlot, value: string | null) => {
      setSelections((prev) => ({ ...prev, [slot]: value }));
    },
    [],
  );

  const handleSubmit = async () => {
    setError(null);
    try {
      await mutation.mutateAsync(selections);
      setIsOpen(false);
      router.refresh();
    } catch (err) {
      setError(extractErrorMessage(err, tErrors));
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={(open) => {
        setIsOpen(open);
        if (!open) setError(null);
      }}
    >
      <Modal.Trigger>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="rounded-lg bg-ink-0 px-3 py-2 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
        >
          <span className="inline-flex items-center gap-1.5">
            <Package className="h-4 w-4" />
            {tSpecs("detail.edit_packaging")}
          </span>
        </Button>
      </Modal.Trigger>
      <Modal.Backdrop>
        <Modal.Container size="md">
          <Modal.Dialog className="overflow-hidden rounded-2xl bg-ink-0 p-0 shadow-lg ring-1 ring-ink-200">
            <Modal.Header className="flex items-center justify-between border-b border-ink-200 px-6 py-4">
              <Modal.Heading className="text-base font-semibold text-ink-1000">
                {tSpecs("packaging.title")}
              </Modal.Heading>
            </Modal.Header>
            <Modal.Body className="flex flex-col gap-5 px-6 py-6">
              <p className="text-sm text-ink-500">
                {tSpecs("packaging.subtitle")}
              </p>

              {isOpen
                ? PACKAGING_SLOTS.map((slot) => {
                    const detailKey = PACKAGING_DETAIL_KEYS[slot];
                    const preselected =
                      sheet.packaging_details[detailKey] ?? null;
                    return (
                      <PackagingCombo
                        key={slot}
                        orgId={orgId}
                        slot={slot}
                        label={tSpecs(
                          `packaging.slots.${slot}` as "packaging.slots.packaging_lid",
                        )}
                        placeholder={tSpecs("packaging.placeholder")}
                        noResultsLabel={tSpecs("packaging.no_results")}
                        clearLabel={tSpecs("packaging.clear")}
                        selectedId={selections[slot] ?? null}
                        preselectedOption={preselected}
                        onSelect={(id) => handleSelect(slot, id)}
                      />
                    );
                  })
                : null}

              {error ? (
                <p
                  role="alert"
                  className="rounded-xl bg-danger/10 px-3 py-2 text-sm font-medium text-danger ring-1 ring-inset ring-danger/20"
                >
                  {error}
                </p>
              ) : null}
            </Modal.Body>
            <Modal.Footer className="flex items-center justify-end gap-3 border-t border-ink-200 px-6 py-4">
              <Button
                type="button"
                variant="outline"
                size="md"
                className="rounded-lg px-4 py-2 font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
                onClick={() => setIsOpen(false)}
                isDisabled={mutation.isPending}
              >
                {tSpecs("create.cancel")}
              </Button>
              <Button
                type="button"
                variant="primary"
                size="md"
                className="rounded-lg bg-orange-500 px-4 py-2 font-medium text-ink-0 hover:bg-orange-600"
                onClick={handleSubmit}
                isDisabled={mutation.isPending}
              >
                {tSpecs("packaging.save")}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}


interface PackagingComboProps {
  orgId: string;
  slot: PackagingSlot;
  label: string;
  placeholder: string;
  noResultsLabel: string;
  clearLabel: string;
  selectedId: string | null;
  preselectedOption: PackagingOption | null;
  onSelect: (id: string | null) => void;
}

/** Render the label copy that shows inside the combo box input for a
 * selected packaging option. Kept as a module-level helper so the
 * display is identical everywhere the option can appear. */
function formatOptionLabel(option: PackagingOption): string {
  return `${option.internal_code} · ${option.name}`;
}


/** One slot's searchable combo box. Debounces the search input
 * before hitting the server and keeps the previously-loaded page
 * visible while the next query resolves.
 *
 * Two text states live side by side:
 * - ``inputValue`` is what the user sees in the input (either the
 *   selected item's label or the query they are typing).
 * - ``searchTerm`` is what we send to the server — it stays empty
 *   while a selection is displayed so the dropdown opens on the
 *   full top-50 list rather than on "this one item matches itself".
 *
 * Once the user starts typing, ``searchTerm`` tracks keystrokes
 * and the server narrows the list. Picking an item snaps the
 * input back to the selected label and resets ``searchTerm``.
 */
function PackagingCombo({
  orgId,
  slot,
  label,
  placeholder,
  noResultsLabel,
  clearLabel,
  selectedId,
  preselectedOption,
  onSelect,
}: PackagingComboProps) {
  const [inputValue, setInputValue] = useState<string>(() =>
    preselectedOption ? formatOptionLabel(preselectedOption) : "",
  );
  const [searchTerm, setSearchTerm] = useState<string>("");
  const debouncedSearch = useDebouncedValue(searchTerm, 250);

  // Keep the display value in sync with the preselected option as
  // the modal (re)opens for different sheets or the sheet DTO
  // changes after a successful save. Syncing by id (not by object
  // identity) avoids double-rendering when the query rehydrates
  // the same selection.
  const lastPreselectedId = useRef<string | null>(
    preselectedOption?.id ?? null,
  );
  useEffect(() => {
    const nextId = preselectedOption?.id ?? null;
    if (nextId === lastPreselectedId.current) return;
    lastPreselectedId.current = nextId;
    setInputValue(
      preselectedOption ? formatOptionLabel(preselectedOption) : "",
    );
    setSearchTerm("");
  }, [preselectedOption]);

  const optionsQuery = usePackagingOptions({
    orgId,
    slot,
    search: debouncedSearch,
    limit: 50,
  });

  // Merge the preselected option into the rendered list so the
  // ComboBox can surface its textValue against ``selectedKey`` even
  // when the latest search page doesn't include it.
  const items = useMemo<readonly PackagingOption[]>(() => {
    const searchResults = optionsQuery.data?.results ?? [];
    if (
      preselectedOption &&
      !searchResults.some((o) => o.id === preselectedOption.id)
    ) {
      return [preselectedOption, ...searchResults];
    }
    return searchResults;
  }, [optionsQuery.data, preselectedOption]);

  const handleInputChange = useCallback((next: string) => {
    // Treat every keystroke as a search query — the user is
    // filtering, not scrolling. If they want to pick the currently
    // selected item again they will reopen the popover and click it.
    setInputValue(next);
    setSearchTerm(next);
  }, []);

  const handleSelectionChange = useCallback(
    (key: Key | null) => {
      if (key === null) {
        onSelect(null);
        setInputValue("");
        setSearchTerm("");
        return;
      }
      const id = String(key);
      onSelect(id);
      const picked =
        items.find((i) => i.id === id) ??
        (preselectedOption && preselectedOption.id === id
          ? preselectedOption
          : null);
      setInputValue(picked ? formatOptionLabel(picked) : "");
      // Reset the search term so reopening the popover shows the
      // top-50 list rather than re-filtering on the selected label.
      setSearchTerm("");
    },
    [items, onSelect, preselectedOption],
  );

  const handleClear = useCallback(() => {
    onSelect(null);
    setInputValue("");
    setSearchTerm("");
  }, [onSelect]);

  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-ink-700">{label}</span>

      <ComboBox
        aria-label={label}
        items={items}
        selectedKey={selectedId}
        inputValue={inputValue}
        onInputChange={handleInputChange}
        onSelectionChange={handleSelectionChange}
        allowsCustomValue={false}
        menuTrigger="focus"
        className="w-full"
      >
        <ComboBox.InputGroup className="flex items-center gap-2 rounded-lg bg-ink-0 px-3 py-2 ring-1 ring-inset ring-ink-200 focus-within:ring-2 focus-within:ring-orange-400">
          <Input
            placeholder={placeholder}
            className="w-full bg-transparent text-sm text-ink-1000 outline-none placeholder:text-ink-500"
          />
          {selectedId ? (
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                handleClear();
              }}
              className="text-xs font-medium text-ink-500 hover:text-ink-1000"
              aria-label={clearLabel}
            >
              {clearLabel}
            </button>
          ) : null}
          <ComboBox.Trigger className="text-xs text-ink-500">
            ▾
          </ComboBox.Trigger>
        </ComboBox.InputGroup>
        <ComboBox.Popover className="max-h-64 overflow-auto rounded-xl bg-ink-0 shadow-lg ring-1 ring-ink-200">
          <ListBox
            items={items}
            renderEmptyState={() => (
              <p className="px-3 py-2 text-xs text-ink-500">
                {optionsQuery.isFetching ? "…" : noResultsLabel}
              </p>
            )}
          >
            {(item) => (
              <ListBox.Item
                id={item.id}
                textValue={formatOptionLabel(item)}
                className="cursor-pointer px-3 py-2 text-sm text-ink-1000 outline-none data-[focused=true]:bg-ink-50 data-[selected=true]:bg-orange-50 data-[selected=true]:text-orange-800"
              >
                <span className="font-medium">{item.internal_code}</span>
                <span className="ml-2 text-ink-500">· {item.name}</span>
              </ListBox.Item>
            )}
          </ListBox>
        </ComboBox.Popover>
      </ComboBox>
    </label>
  );
}


function extractErrorMessage(
  error: unknown,
  tErrors: ReturnType<typeof useTranslations<"errors">>,
): string {
  if (error instanceof ApiError) {
    for (const codes of Object.values(error.fieldErrors)) {
      if (Array.isArray(codes) && codes.length > 0) {
        return translateCode(tErrors, String(codes[0]));
      }
    }
  }
  return tErrors("generic");
}
