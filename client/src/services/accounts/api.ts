/**
 * Raw Axios calls for the accounts domain.
 *
 * Functions here are thin wrappers around ``apiClient`` — they only know
 * how to send a request and unwrap the response. Everything else
 * (caching, retries, error mapping) is handled by the interceptors and
 * the corresponding TanStack Query hooks.
 */

import { apiClient } from "@/lib/api";

import { accountsEndpoints } from "./endpoints";
import type {
  LoginRequestDto,
  LoginResponseDto,
  PasswordResetConfirmDto,
  PasswordResetRequestDto,
  RegisterRequestDto,
  RegisterResponseDto,
  UserDto,
} from "./types";

export async function registerUser(
  payload: RegisterRequestDto,
): Promise<RegisterResponseDto> {
  const { data } = await apiClient.post<RegisterResponseDto>(
    accountsEndpoints.register,
    payload,
  );
  return data;
}

export async function loginUser(
  payload: LoginRequestDto,
): Promise<LoginResponseDto> {
  const { data } = await apiClient.post<LoginResponseDto>(
    accountsEndpoints.login,
    payload,
  );
  return data;
}

export async function logoutUser(): Promise<void> {
  await apiClient.post(accountsEndpoints.logout);
}

export async function fetchCurrentUser(): Promise<UserDto> {
  const { data } = await apiClient.get<UserDto>(accountsEndpoints.me);
  return data;
}


export interface UpdateMeRequestDto {
  readonly first_name?: string;
  readonly last_name?: string;
}


export async function updateCurrentUser(
  payload: UpdateMeRequestDto,
): Promise<UserDto> {
  const { data } = await apiClient.patch<UserDto>(
    accountsEndpoints.me,
    payload,
  );
  return data;
}

export async function requestPasswordReset(
  payload: PasswordResetRequestDto,
): Promise<void> {
  await apiClient.post(accountsEndpoints.passwordResetRequest, payload);
}

/** Peek at a reset token's validity *before* showing the password
 *  form. Returns ``true`` if the token is currently consumable. The
 *  caller does not get to know which specific failure mode the
 *  token is in — that is surfaced by the confirm endpoint where the
 *  user can see a meaningful next step. */
export async function validatePasswordResetToken(token: string): Promise<true> {
  await apiClient.get(accountsEndpoints.passwordResetValidate, {
    params: { token },
  });
  return true;
}

export async function confirmPasswordReset(
  payload: PasswordResetConfirmDto,
): Promise<void> {
  await apiClient.post(accountsEndpoints.passwordResetConfirm, payload);
}
