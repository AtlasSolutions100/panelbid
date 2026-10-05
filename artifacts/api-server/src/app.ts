import express, { Router, type Express, type IRouter } from "express";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import router from "./routes";
import apiGate from "./middlewares/apiGate";
import { logger } from "./lib/logger";

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

app.use("/api", api);

export default app;
