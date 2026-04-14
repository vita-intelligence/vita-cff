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
  fetchCurrentUser,
  loginUser,
  logoutUser,
  registerUser,
} from "./api";
import type {
  LoginRequestDto,
  LoginResponseDto,
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
