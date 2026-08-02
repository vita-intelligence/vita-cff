"use client";

/**
 * Read-only Puck renderer. Used by the customer portal to display
 * a page that was authored in the staff builder. Shares the exact
 * same ``pageBuilderConfig`` as the editor so what staff sees is
 * what shoppers see, byte-for-byte.
 *
 * Safe by design: unlike the legacy sanitized-HTML path we don't
 * need bleach — Puck walks a fixed component schema, so an
 * attacker-crafted JSON payload can only invoke components we've
 * registered, never inject scripts.
 */

import { Render } from "@puckeditor/core";
import type { ComponentProps } from "react";

import { pageBuilderConfig } from "./config";


interface Props {
  //: JSON payload authored in the builder. Anything not matching
  //: the config's schema is silently ignored by Puck's Render.
  readonly data: unknown;
}


export function PageBuilderRender({ data }: Props) {
  if (!data || typeof data !== "object") return null;
  return (
    <Render
      config={pageBuilderConfig}
      data={data as ComponentProps<typeof Render>["data"]}
    />
  );
}
