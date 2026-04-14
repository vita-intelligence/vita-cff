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
