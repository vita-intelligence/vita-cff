/**
 * Transport types for the accounts domain. Mirror the backend serializer
 * output exactly — nothing more, nothing less.
 */

export interface UserDto {
  readonly id: string;
  readonly email: string;
  readonly first_name: string;
  readonly last_name: string;
  readonly full_name: string;
  readonly date_joined: string;
}

export interface RegisterRequestDto {
  readonly email: string;
  readonly first_name: string;
  readonly last_name: string;
  readonly password: string;
  readonly password_confirm: string;
}

export type RegisterResponseDto = UserDto;

export interface LoginRequestDto {
  readonly email: string;
  readonly password: string;
}

export type LoginResponseDto = UserDto;
