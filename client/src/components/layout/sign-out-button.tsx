"use client";

import { Button } from "@heroui/react";
import { LogOut } from "lucide-react";
import { useTranslations } from "next-intl";

import { useRouter } from "@/i18n/navigation";
import { useLogout } from "@/services/accounts";

export function SignOutButton() {
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
      className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-ink-0 px-3 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
      isDisabled={logout.isPending}
      onClick={handleLogout}
    >
      <LogOut className="h-4 w-4" />
      <span className="hidden sm:inline">{tNav("account.sign_out")}</span>
    </Button>
  );
}
