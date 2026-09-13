import { AuthenticationError } from "../shared/errors/index.js";
import { publicEmployee } from "../modules/auth/auth.service.js";
import { verifyAccessToken } from "../modules/auth/token.service.js";

export function createAuthenticate(prisma) {
  return async function authenticate(request, _response, next) {
    try {
      const header = request.get("authorization") || "";
      const [scheme, token] = header.split(" ");
      if (scheme !== "Bearer" || !token) throw new AuthenticationError();
      const payload = verifyAccessToken(token);
      const [employee, session] = await Promise.all([
        prisma.employee.findUnique({
          where: { id: payload.sub },
          include: {
            company: true, modules: true,
            roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } },
          },
        }),
        prisma.session.findUnique({ where: { id: payload.sessionId } }),
      ]);
      if (!employee || employee.deletedAt || employee.status !== "ACTIVE"
        || employee.companyId !== payload.companyId || employee.tokenVersion !== payload.tokenVersion
        || !["ACTIVE", "TRIAL"].includes(employee.company?.status)
        || (employee.company.status === "TRIAL" && employee.company.trialEndsAt && employee.company.trialEndsAt <= new Date())
        || !session || session.revokedAt || session.expiresAt <= new Date()) {
        throw new AuthenticationError("Session is no longer active");
      }
      request.auth = {
        employeeId: employee.id, companyId: employee.companyId, sessionId: session.id,
        user: publicEmployee(employee),
      };
      return next();
    } catch (error) { return next(error); }
  };
}
