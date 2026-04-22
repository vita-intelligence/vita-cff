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
  /** Opaque profile-photo URL. Empty string renders as initials.
   *  Today a base64 data URL on the backend; a future migration to
   *  blob storage replaces it with a CDN URL — every consumer
   *  already treats this as an opaque string. */
  readonly avatar_image: string;
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
