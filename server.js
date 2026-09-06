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
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false
});

/* AUTO CREATE ADMIN */
async function createAdmin() {
  try {
    const hash = await bcrypt.hash("admin123", 10);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role VARCHAR(20) NOT NULL,
        member_id INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(
      `
      INSERT INTO users(username,password_hash,role)
      VALUES('admin',$1,'admin')
      ON CONFLICT(username) DO NOTHING
    `,
      [hash]
    );

    console.log("Admin account ready");
  } catch (err) {
    console.error(err);
  }
}

createAdmin();

async function updateMembersTable() {
  try {
    await pool.query(`
      ALTER TABLE members
      ADD COLUMN IF NOT EXISTS latitude NUMERIC(10,6)
    `);

    await pool.query(`
      ALTER TABLE members
      ADD COLUMN IF NOT EXISTS longitude NUMERIC(10,6)
    `);

    console.log("Members table updated");
  } catch (err) {
    console.error(err);
  }
}

updateMembersTable();
const PgStore = connectPgSimple(session);

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(
  session({
    store: new PgStore({
      pool,
      tableName: "user_sessions",
      createTableIfMissing: true
    }),
    secret: process.env.SESSION_SECRET || "mprphc-secret",
    resave: false,
    saveUninitialized: false
  })
);

function requireLogin(req, res, next) {
  if (!req.session.user) {
    return res.redirect("/");
  }
  next();
}

/* LOGIN PAGE */
app.get("/", (req, res) => {
  if (req.session.user) {
    return res.redirect("/dashboard");
  }

  res.render("login");
});

/* LOGIN */
app.post("/login", async (req, res) => {
  app.post("/admin/create-member", requireLogin, async (req, res) => {
  if (req.session.user.role !== "organizer") {
    return res.send("Access denied");
  }

  try {
    const { username, password } = req.body;

    const hash = await bcrypt.hash(password, 10);

    await pool.query(
      `
      INSERT INTO users
      (username,password_hash,role)
      VALUES($1,$2,'member')
      `,
      [username, hash]
    );

    res.send("Member account created successfully");
  } catch (err) {
    res.send(err.message);
  }
});
  try {
    const { username, password } = req.body;

    const result = await pool.query(
      "SELECT * FROM users WHERE username=$1",
      [username]
    );

    if (result.rows.length === 0) {
      return res.send("Invalid username or password");
    }

    const user = result.rows[0];

    const valid = await bcrypt.compare(
      password,
      user.password_hash
    );

    if (!valid) {
      return res.send("Invalid username or password");
    }

    req.session.user = {
      id: user.id,
      username: user.username,
      role: user.role
    };

    res.redirect("/dashboard");
  } catch (err) {
    res.send(err.message);
  }
});

/* LOGOUT */
app.get("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/");
  });
});

/* DASHBOARD */
app.get("/dashboard", requireLogin, async (req, res) => {
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

app.get("/members/new", requireLogin, (req, res) => {
  if (req.session.user.role !== "organizer") {
    return res.send("Access denied");
  }

  res.render("member-form");
});
app.post("/members/new", requireLogin, async (req, res) => {
  try {
    const {
      member_no,
      name,
      contact,
      loft_name,
      address,
      latitude,
      longitude
    } = req.body;

    await pool.query(
      `
      INSERT INTO members
      (
        member_no,
        name,
        contact,
        loft_name,
        address,
        latitude,
        longitude
      )
      VALUES($1,$2,$3,$4,$5,$6,$7)
      `,
      [
        member_no,
        name,
        contact,
        loft_name,
        address,
        latitude,
        longitude
      ]
    );

    res.redirect("/members");
  } catch (err) {
    res.send(err.message);
  }
});
app.get("/members", requireLogin, async (req, res) => {
  const result = await pool.query(
    "SELECT * FROM members ORDER BY id DESC"
  );

  res.render("lofts", {
    members: result.rows
  });
});

app.get("/pigeons", requireLogin, async (req, res) => {
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

app.get("/races", requireLogin, async (req, res) => {
  const result = await pool.query(
    "SELECT * FROM races ORDER BY id DESC"
  );

  res.render("races", {
    races: result.rows
  });
});

app.get("/results", requireLogin, async (req, res) => {
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

app.get("/admin/create-member", requireLogin, (req, res) => {
  if (req.session.user.role !== "organizer") {
    return res.send("Access denied");
  }

  res.render("create-member");
});

app.post("/admin/create-member", requireLogin, async (req, res) => {
  try {
    const { username, password } = req.body;

    const hash = await bcrypt.hash(password, 10);

    await pool.query(
      `
      INSERT INTO users(username, password_hash, role)
      VALUES($1, $2, 'member')
      `,
      [username, hash]
    );

    res.send("Member account created successfully");
  } catch (err) {
    res.send(err.message);
  }
});
