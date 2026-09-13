import { AppError } from "./AppError.js";

export class AuthorizationError extends AppError {
  constructor(message = "You do not have permission to perform this action", details) {
    super(message, { statusCode: 403, code: "FORBIDDEN", details });
  }
}

export default AuthorizationError;
