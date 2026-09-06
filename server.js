import bcrypt from "bcryptjs";
import express from "express";
import session from "express-session";
import pg from "pg";
import connectPgSimple from "connect-pg-simple";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production"
    ? { rejectUnauthorized: false }
    : false
});

const PgStore = connectPgSimple(session);

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(express.static(path.join(__dirname, "public")));

app.use(
  session({
    store: new PgStore({
      pool,
      tableName: "user_sessions"
    }),
    secret: process.env.SESSION_SECRET || "mprphc-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 1000 * 60 * 60 * 24
    }
  })
);

app.get("/", (req, res) => {
  res.render("login");
});

app.get("/dashboard", async (req, res) => {
  try {
    const members = await pool.query(
      "SELECT COUNT(*) FROM members"
    );

    const pigeons = await pool.query(
      "SELECT COUNT(*) FROM pigeons"
    );

    const races = await pool.query(
      "SELECT COUNT(*) FROM races"
    );

    res.render("dashboard", {
      members: members.rows[0].count,
      pigeons: pigeons.rows[0].count,
      races: races.rows[0].count
    });
  } catch (err) {
    res.send(err.message);
  }
});

app.get("/members", async (req, res) => {
  const result = await pool.query(
    "SELECT * FROM members ORDER BY id DESC"
  );

  res.render("lofts", {
    members: result.rows
  });
});

app.get("/pigeons", async (req, res) => {
  const result = await pool.query(`
    SELECT pigeons.*, members.name AS owner
    FROM pigeons
    LEFT JOIN members
    ON pigeons.member_id = members.id
    ORDER BY pigeons.id DESC
  `);

  res.render("pigeons", {
    pigeons: result.rows
  });
});

app.get("/races", async (req, res) => {
  const result = await pool.query(
    "SELECT * FROM races ORDER BY id DESC"
  );

  res.render("races", {
    races: result.rows
  });
});

app.get("/results", async (req, res) => {
  const result = await pool.query(`
    SELECT
      races.name,
      pigeons.ring_no,
      members.name AS owner
    FROM entries
    JOIN races ON races.id = entries.race_id
    JOIN pigeons ON pigeons.id = entries.pigeon_id
    JOIN members ON members.id = pigeons.member_id
    ORDER BY races.id DESC
  `);

  res.render("results", {
    results: result.rows
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
