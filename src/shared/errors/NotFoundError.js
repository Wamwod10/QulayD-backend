import { AppError } from "./AppError.js";

export class NotFoundError extends AppError {
  constructor(message = "Resource not found", details) {
    super(message, { statusCode: 404, code: "NOT_FOUND", details });
  }
}

export default NotFoundError;
