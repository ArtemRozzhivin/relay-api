import z from 'zod';

export const loginSchema = z
  .object({ email: z.email(), password: z.string().min(8) })
  .strict();

export type LoginInput = z.infer<typeof loginSchema>;

export const registerSchema = z
  .object({
    email: z.email(),
    password: z.string().min(8),
  })
  .strict();

export type RegisterInput = z.infer<typeof registerSchema>;

export const refreshSchema = z.object({ refreshToken: z.string().min(1) }).strict();

export type RefreshInput = z.infer<typeof refreshSchema>;
