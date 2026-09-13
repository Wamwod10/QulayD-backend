import { AppError } from "./AppError.js";

export class AuthenticationError extends AppError {
  constructor(message = "Authentication is required", details) {
    super(message, { statusCode: 401, code: "AUTHENTICATION_REQUIRED", details });
  }
}

export default AuthenticationError;
