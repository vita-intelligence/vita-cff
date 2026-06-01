"use client";

import { use } from "react";

import { PortalLabelDesignWorkspace } from "./workspace";


export default function PortalLabelDesignDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  return <PortalLabelDesignWorkspace id={id} />;
}
