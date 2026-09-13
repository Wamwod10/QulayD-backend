process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
process.env.DATABASE_URL ||= "postgresql://postgres:postgres@localhost:5432/qulay_test?schema=public";
process.env.CORS_ORIGIN ||= "http://localhost:5173";
process.env.RATE_LIMIT_MAX ||= "1000";
