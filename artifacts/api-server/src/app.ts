import express, {
  Router,
  type Express,
  type IRouter,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import router from "./routes";
import apiGate from "./middlewares/apiGate";
import { logger } from "./lib/logger";
import { SERVER_FAULT_MESSAGE } from "./lib/readingFailures";

const app: Express = express();
app.disable("x-powered-by");

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cookieParser());

// Everything the app can answer lives under /api, and the sign-in gate is
// the first thing there: a route added to `router` later is behind it
// without anyone having to remember. Request bodies are only read after the
// gate has let the request through. There is no CORS middleware on purpose:
// no other website may call this API.
//
// Do not register routes on `app` itself or in front of `apiGate`.
// src/apiGuard.test.ts walks these tables and fails if anything answers
// without a session.
const api: IRouter = Router();
api.use(apiGate);
api.use(express.json());
api.use(express.urlencoded({ extended: true }));
api.use(router);

// Last under /api: an error no route planned for. The person gets a status
// and one plain sentence; what happened is in the log. Never a stack trace,
// never the error's own text.
api.use((err: unknown, req: Request, res: Response, next: NextFunction): void => {
  if (res.headersSent) {
    next(err);
    return;
  }
  const claimed = (err as { status?: unknown; statusCode?: unknown } | null) ?? {};
  const status =
    typeof claimed.status === "number"
      ? claimed.status
      : typeof claimed.statusCode === "number"
        ? claimed.statusCode
        : 500;
  if (status >= 400 && status < 500) {
    req.log.warn({ err, status }, "Request refused");
    res.status(status).json({
      code: "bad_request",
      message: "The request could not be read. Reload the page and try again.",
    });
    return;
  }
  req.log.error({ err }, "Request failed");
  res.status(500).json({ code: "server_fault", message: SERVER_FAULT_MESSAGE });
});

app.use("/api", api);

export default app;
