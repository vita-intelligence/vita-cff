/** Transport types for the customers domain. */

export interface CustomerDto {
  readonly id: string;
  readonly name: string;
  readonly company: string;
  readonly email: string;
  readonly phone: string;
  readonly invoice_address: string;
  readonly delivery_address: string;
  readonly notes: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface CreateCustomerRequestDto {
  readonly name?: string;
  readonly company?: string;
  readonly email?: string;
  readonly phone?: string;
  readonly invoice_address?: string;
  readonly delivery_address?: string;
  readonly notes?: string;
}

export type UpdateCustomerRequestDto = CreateCustomerRequestDto;
