export class AppError extends Error {
  constructor(message, {
    statusCode = 500,
    code = "INTERNAL_ERROR",
    details,
    cause,
    isOperational = true,
  } = {}) {
    super(message, { cause });
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = isOperational;
    Error.captureStackTrace?.(this, this.constructor);
  }
}

export default AppError;
