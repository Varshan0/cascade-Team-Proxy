/** Consistent error shape: { error: { code, message, details? } } (spec section 9). */
export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const errors = {
  badRequest: (message: string, details?: unknown) => new ApiError(400, 'bad_request', message, details),
  unauthorized: (message = 'Authentication required') => new ApiError(401, 'unauthorized', message),
  notFound: (message = 'Not found') => new ApiError(404, 'not_found', message),
  conflict: (message: string) => new ApiError(409, 'conflict', message),
  unavailable: (message: string, details?: unknown) => new ApiError(503, 'unavailable', message, details),
};
