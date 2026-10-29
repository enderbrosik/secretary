export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const notFound = (what = 'Resource') => new AppError(404, 'not_found', `${what} not found`);
export const badRequest = (msg: string, details?: unknown) => new AppError(400, 'bad_request', msg, details);
export const forbidden = (msg = 'Not allowed') => new AppError(403, 'forbidden', msg);
export const unauthorized = (msg = 'Sign in required') => new AppError(401, 'unauthorized', msg);
export const conflict = (msg: string) => new AppError(409, 'conflict', msg);
