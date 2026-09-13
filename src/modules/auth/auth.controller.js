import { env } from "../../config/env.js";
import { sendSuccess } from "../../shared/responses/index.js";
import { REFRESH_COOKIE } from "./auth.constants.js";

const context = (request) => ({ ipAddress: request.ip, userAgent: request.get("user-agent") });
const cookieOptions = {
  httpOnly: true,
  secure: env.NODE_ENV === "production",
  // The Vercel frontend and Render API are different sites in production.
  // Development remains HTTP-friendly while production cookies are explicitly
  // eligible for credentialed cross-site requests.
  sameSite: env.NODE_ENV === "production" ? "none" : "lax",
  maxAge: env.JWT_REFRESH_TTL_DAYS * 86_400_000, path: `${env.API_PREFIX}/auth`,
};
const sessionResponse = (response, result, statusCode = 200) => {
  response.cookie(REFRESH_COOKIE, result.refreshToken, cookieOptions);
  return sendSuccess(response, { statusCode, data: { accessToken: result.accessToken, user: result.user } });
};

export function createAuthController(service) {
  return {
    register: async (request, response) => sessionResponse(response,
      await service.registerOwner(request.validated.body, context(request)), 201),
    login: async (request, response) => sessionResponse(response,
      await service.login(request.validated.body, context(request))),
    pinLogin: async (request, response) => sessionResponse(response,
      await service.loginWithPin(request.validated.body, context(request))),
    refresh: async (request, response) => {
      const token = request.validated.body.refreshToken || request.cookies[REFRESH_COOKIE];
      return sessionResponse(response, await service.refresh(token, context(request)));
    },
    logout: async (request, response) => {
      await service.logout(request.auth?.sessionId);
      response.clearCookie(REFRESH_COOKIE, cookieOptions);
      return sendSuccess(response, { data: { loggedOut: true } });
    },
    me: async (request, response) => sendSuccess(response, { data: request.auth.user }),
    changePassword: async (request, response) => {
      await service.changePassword(request.auth.employeeId, request.validated.body);
      response.clearCookie(REFRESH_COOKIE, cookieOptions);
      return sendSuccess(response, { data: { changed: true } });
    },
    forgotPassword: async (request, response) => {
      const token = await service.forgotPassword(request.validated.body.identifier);
      return sendSuccess(response, { data: {
        accepted: true,
        ...(env.NODE_ENV !== "production" && token ? { resetToken: token } : {}),
      } });
    },
    resetPassword: async (request, response) => {
      await service.resetPassword(request.validated.body);
      return sendSuccess(response, { data: { reset: true } });
    },
    sessions: async (request, response) => sendSuccess(response, {
      data: await service.listSessions(request.auth.employeeId),
    }),
    revokeSession: async (request, response) => {
      await service.revokeSession(request.auth.employeeId, request.params.id, "USER_REVOKED");
      return sendSuccess(response, { data: { revoked: true } });
    },
  };
}
