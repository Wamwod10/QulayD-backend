import { ValidationError } from "../shared/errors/ValidationError.js";

const REQUEST_PARTS = ["params", "query", "body"];

function formatIssues(issues) {
  return issues.map((issue) => ({
    path: issue.path.join("."),
    code: issue.code,
    message: issue.message,
  }));
}

export function validate(schemas = {}) {
  return function validationMiddleware(request, _response, next) {
    const validated = {};
    const errors = [];

    for (const part of REQUEST_PARTS) {
      const schema = schemas[part];
      if (!schema) continue;
      const result = schema.safeParse(request[part]);
      if (!result.success) {
        errors.push(...formatIssues(result.error.issues).map((issue) => ({ ...issue, location: part })));
      } else {
        validated[part] = result.data;
      }
    }

    if (errors.length) {
      next(new ValidationError("Request validation failed", { fields: errors }));
      return;
    }

    request.validated = validated;
    if (validated.body) request.body = validated.body;
    if (validated.params) request.params = validated.params;
    next();
  };
}

export default validate;
