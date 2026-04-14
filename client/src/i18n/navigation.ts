/**
 * Typed navigation helpers.
 *
 * Import ``Link``, ``useRouter``, ``usePathname``, and ``redirect`` from
 * this file instead of ``next/link`` / ``next/navigation`` so internal
 * links are automatically locale-aware.
 */

import { createNavigation } from "next-intl/navigation";

import { routing } from "./routing";

export const { Link, redirect, usePathname, useRouter, getPathname } =
  createNavigation(routing);
