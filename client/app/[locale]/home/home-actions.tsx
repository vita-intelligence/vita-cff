"use client";

import { Button } from "@heroui/react";
import { useTranslations } from "next-intl";

import { useRouter } from "@/i18n/navigation";
import { useLogout } from "@/services/accounts";

export function HomeActions() {
  const tNav = useTranslations("navigation");
  const router = useRouter();
  const logout = useLogout();

  const handleLogout = async () => {
    try {
      await logout.mutateAsync();
    } finally {
      router.replace("/login");
    }
  };

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="rounded-none border-2 font-bold tracking-wider uppercase"
      isDisabled={logout.isPending}
      onClick={handleLogout}
    >
      {tNav("account.sign_out")}
    </Button>
  );
}
