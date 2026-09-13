import { AppError } from "./AppError.js";

export class ValidationError extends AppError {
  constructor(message = "Request validation failed", details) {
    super(message, { statusCode: 422, code: "VALIDATION_ERROR", details });
  }
}

export default ValidationError;
