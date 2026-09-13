import { AppError } from "./AppError.js";

export class ConflictError extends AppError {
  constructor(message = "The requested operation conflicts with current data", details) {
    super(message, { statusCode: 409, code: "CONFLICT", details });
  }
}

export default ConflictError;
