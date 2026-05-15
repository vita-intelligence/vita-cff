/**
 * TanStack Query hooks for the accounts domain.
 *
 * Every component that needs accounts data should consume these hooks —
 * never call the raw API functions directly. That way caching,
 * invalidation, and loading states stay consistent across the app.
 */

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";

import type { ApiError } from "@/lib/api";
import { rootQueryKey } from "@/lib/query";

import {
  confirmPasswordReset,
  fetchCurrentUser,
  loginUser,
  logoutUser,
  registerUser,
  requestPasswordReset,
  updateCurrentUser,
  validatePasswordResetToken,
  type UpdateMeRequestDto,
} from "./api";
import type {
  LoginRequestDto,
  LoginResponseDto,
  PasswordResetConfirmDto,
  PasswordResetRequestDto,
  RegisterRequestDto,
  RegisterResponseDto,
  UserDto,
} from "./types";

export const accountsQueryKeys = {
  all: [...rootQueryKey, "accounts"] as const,
  me: () => [...accountsQueryKeys.all, "me"] as const,
} as const;

export function useRegister(): UseMutationResult<
  RegisterResponseDto,
  ApiError,
  RegisterRequestDto
> {
  const queryClient = useQueryClient();
  return useMutation<RegisterResponseDto, ApiError, RegisterRequestDto>({
    mutationFn: registerUser,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: accountsQueryKeys.all });
    },
  });
}

export function useLogin(): UseMutationResult<
  LoginResponseDto,
  ApiError,
  LoginRequestDto
> {
  const queryClient = useQueryClient();
  return useMutation<LoginResponseDto, ApiError, LoginRequestDto>({
    mutationFn: loginUser,
    onSuccess: async (user) => {
      // Prime the cache so the /home server-component check hits immediately
      // on the next navigation rather than firing another /me/ request.
      queryClient.setQueryData(accountsQueryKeys.me(), user);
    },
  });
}

export function useLogout(): UseMutationResult<void, ApiError, void> {
  const queryClient = useQueryClient();
  return useMutation<void, ApiError, void>({
    mutationFn: logoutUser,
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: accountsQueryKeys.all });
    },
  });
}

export function useCurrentUser(
  options: { enabled?: boolean } = {},
): UseQueryResult<UserDto, ApiError> {
  return useQuery<UserDto, ApiError>({
    queryKey: accountsQueryKeys.me(),
    queryFn: fetchCurrentUser,
    enabled: options.enabled ?? true,
  });
}


export function useUpdateCurrentUser(): UseMutationResult<
  UserDto,
  ApiError,
  UpdateMeRequestDto
> {
  const queryClient = useQueryClient();
  return useMutation<UserDto, ApiError, UpdateMeRequestDto>({
    mutationFn: updateCurrentUser,
    onSuccess: (user) => {
      // Prime + invalidate — the updated response is cheap to carry
      // forward as the new ``me`` cache, but Server Components still
      // re-fetch on the next navigation because they bypass the
      // React Query cache entirely.
      queryClient.setQueryData(accountsQueryKeys.me(), user);
    },
  });
}

export function useRequestPasswordReset(): UseMutationResult<
  void,
  ApiError,
  PasswordResetRequestDto
> {
  return useMutation<void, ApiError, PasswordResetRequestDto>({
    mutationFn: requestPasswordReset,
  });
}

/** TanStack ``useQuery`` wrapper around the validate endpoint.
 *  ``enabled`` is bound to whether a token is present so the reset
 *  page can show its own missing-token state before this fires.
 *  ``retry: false`` keeps a 400 (expired / used / invalid) from
 *  bouncing the user through three retries before they see the
 *  error state. */
export function useValidatePasswordResetToken(
  token: string | undefined,
): UseQueryResult<void, ApiError> {
  return useQuery<void, ApiError>({
    queryKey: [...accountsQueryKeys.all, "password-reset", "validate", token],
    queryFn: () => validatePasswordResetToken(token ?? ""),
    enabled: Boolean(token),
    retry: false,
    staleTime: 0,
  });
}

export function useConfirmPasswordReset(): UseMutationResult<
  void,
  ApiError,
  PasswordResetConfirmDto
> {
  return useMutation<void, ApiError, PasswordResetConfirmDto>({
    mutationFn: confirmPasswordReset,
  });
}
