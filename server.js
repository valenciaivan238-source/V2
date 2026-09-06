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

async function updateEntriesTable() {
  try {
    await pool.query(`
      ALTER TABLE entries
      ADD COLUMN IF NOT EXISTS verification_code VARCHAR(5)
    `);

    console.log("Entries table updated");
  } catch (err) {
    console.error("Entries table update error:", err);
  }
}

updateEntriesTable();

async function updateRacesTable() {
  try {
    await pool.query(`
      ALTER TABLE races
      ADD COLUMN IF NOT EXISTS release_latitude NUMERIC(10,6)
    `);

    await pool.query(`
      ALTER TABLE races
      ADD COLUMN IF NOT EXISTS release_longitude NUMERIC(10,6)
    `);

    console.log("Races table updated");
  } catch (err) {
    console.error("Races table update error:", err);
  }
}

updateRacesTable();

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
      user: req.session.user,
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

  if (req.session.user.role !== "organizer") {
    return res.send("Access denied");
  }

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
    user: req.session.user,
    pigeons: result.rows
  });
});

app.get("/pigeons/new", requireLogin, async (req, res) => {

  if (req.session.user.role !== "organizer") {
    return res.send("Access denied");
  }

  const members = await pool.query(
    "SELECT * FROM members ORDER BY name"
  );

  res.render("pigeon-form", {
    members: members.rows
  });

});
app.post("/pigeons/new", requireLogin, async (req, res) => {

  if (req.session.user.role !== "organizer") {
    return res.send("Access denied");
  }

  try {

    const {
      ring_no,
      name,
      sex,
      color,
      birth_year,
      member_id
    } = req.body;

    await pool.query(
      `
      INSERT INTO pigeons
      (
        ring_no,
        name,
        sex,
        color,
        birth_year,
        member_id
      )
      VALUES($1,$2,$3,$4,$5,$6)
      `,
      [
        ring_no,
        name,
        sex,
        color,
        birth_year,
        member_id
      ]
    );

    res.redirect("/pigeons");

  } catch (err) {
    res.send(err.message);
  }

});
app.get("/races", requireLogin, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM races ORDER BY id DESC"
    );

    res.render("races", {
      user: req.session.user,
      races: result.rows
    });

  } catch (err) {
    console.error("RACES PAGE ERROR:", err);
    res.status(500).send(err.message);
  }
});
/* CREATE RACE PAGE */
app.get("/races/new", requireLogin, (req, res) => {
  if (req.session.user.role !== "organizer") {
    return res.send("Access denied");
  }

  res.render("race-form");
});


/* CREATE RACE */
app.post("/races/new", requireLogin, async (req, res) => {
  if (req.session.user.role !== "organizer") {
    return res.send("Access denied");
  }

  try {
    const {
      name,
      category,
      release_point,
      release_latitude,
      release_longitude,
      distance_km,
      race_date,
      release_time,
      entry_fee,
      status
    } = req.body;

    await pool.query(
      `
      INSERT INTO races
      (
        name,
        category,
        release_point,
        distance_km,
        race_date,
        release_time,
        entry_fee,
        status
      )
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)
      `,
      [
        name,
        category,
        release_point,
        distance_km || null,
        race_date,
        release_time || null,
        entry_fee || 0,
        status || "Open"
      ]
    );

    res.redirect("/races");

  } catch (err) {
    console.error("CREATE RACE ERROR:", err);
    res.send(err.message);
  }
});
/* RACE ENTRIES PAGE */
app.get("/races/:id/entries", requireLogin, async (req, res) => {
  if (
    req.session.user.role !== "organizer" &&
    req.session.user.role !== "admin"
  ) {
    return res.status(403).send("Access denied");
  }

  try {
    const raceId = req.params.id;

    // Get race
    const raceResult = await pool.query(
      "SELECT * FROM races WHERE id = $1",
      [raceId]
    );

    if (raceResult.rows.length === 0) {
      return res.status(404).send("Race not found");
    }

    // Get all active pigeons with their owners
    const pigeonsResult = await pool.query(`
      SELECT
        pigeons.id,
        pigeons.ring_no,
        pigeons.name,
        pigeons.sex,
        pigeons.color,
        members.id AS member_id,
        members.member_no,
        members.name AS owner
      FROM pigeons
      JOIN members
        ON members.id = pigeons.member_id
      WHERE pigeons.status = 'Active'
      ORDER BY members.name, pigeons.ring_no
    `);

    // Get pigeons already entered in this race
    const entriesResult = await pool.query(`
      SELECT
        entries.id,
        entries.paid,
        entries.verification_code,
        pigeons.ring_no,
        pigeons.name AS pigeon_name,
        members.member_no,
        members.name AS owner
      FROM entries
      JOIN pigeons
        ON pigeons.id = entries.pigeon_id
      JOIN members
        ON members.id = pigeons.member_id
      WHERE entries.race_id = $1
      ORDER BY members.name, pigeons.ring_no
    `, [raceId]);

    res.render("race-entries", {
      user: req.session.user,
      race: raceResult.rows[0],
      pigeons: pigeonsResult.rows,
      entries: entriesResult.rows
    });

  } catch (err) {
    console.error("RACE ENTRIES ERROR:", err);
    res.status(500).send(err.message);
  }
});


/* ADD PIGEON TO RACE */
app.post("/races/:id/entries", requireLogin, async (req, res) => {
  if (
    req.session.user.role !== "organizer" &&
    req.session.user.role !== "admin"
  ) {
    return res.status(403).send("Access denied");
  }

  try {
    const raceId = req.params.id;
    const { pigeon_id } = req.body;

    if (!pigeon_id) {
      return res.status(400).send("Please select a pigeon.");
    }

    // Check race exists
    const raceResult = await pool.query(
      "SELECT id FROM races WHERE id = $1",
      [raceId]
    );

    if (raceResult.rows.length === 0) {
      return res.status(404).send("Race not found");
    }

    // Check pigeon exists
    const pigeonResult = await pool.query(
      "SELECT id FROM pigeons WHERE id = $1",
      [pigeon_id]
    );

    if (pigeonResult.rows.length === 0) {
      return res.status(404).send("Pigeon not found");
    }

    // Add entry
    await pool.query(
      `
      INSERT INTO entries (race_id, pigeon_id)
      VALUES ($1, $2)
      `,
      [raceId, pigeon_id]
    );

    res.redirect(`/races/${raceId}/entries`);

  } catch (err) {
    console.error("ADD ENTRY ERROR:", err);

    // Same pigeon cannot be entered twice in the same race
    if (err.code === "23505") {
      return res.status(400).send(
        "This pigeon is already entered in this race."
      );
    }

    res.status(500).send(err.message);
  }
});


/* REMOVE PIGEON FROM RACE */
app.post("/races/:raceId/entries/:entryId/delete", requireLogin, async (req, res) => {
  if (
    req.session.user.role !== "organizer" &&
    req.session.user.role !== "admin"
  ) {
    return res.status(403).send("Access denied");
  }

  try {
    const { raceId, entryId } = req.params;

    await pool.query(
      `
      DELETE FROM entries
      WHERE id = $1
      AND race_id = $2
      `,
      [entryId, raceId]
    );

    res.redirect(`/races/${raceId}/entries`);

  } catch (err) {
    console.error("DELETE ENTRY ERROR:", err);
    res.status(500).send(err.message);
  }
});
/* ================================
   RACE ENTRIES
================================ */

/* VIEW RACE ENTRIES */
app.get("/races/:id/entries", requireLogin, async (req, res) => {

  if (req.session.user.role !== "organizer") {
    return res.status(403).send("Access denied");
  }

  try {
    const raceId = req.params.id;

    // Get selected race
    const raceResult = await pool.query(
      "SELECT * FROM races WHERE id = $1",
      [raceId]
    );

    if (raceResult.rows.length === 0) {
      return res.status(404).send("Race not found");
    }

    // Get all pigeons with their owner
    const pigeonsResult = await pool.query(`
      SELECT
        pigeons.id,
        pigeons.ring_no,
        pigeons.name,
        pigeons.sex,
        pigeons.color,
        members.member_no,
        members.name AS owner
      FROM pigeons
      JOIN members
        ON pigeons.member_id = members.id
      WHERE pigeons.status = 'Active'
      ORDER BY members.name, pigeons.ring_no
    `);

    // Get pigeons already entered in this race
    const entriesResult = await pool.query(`
      SELECT
        entries.id,
        entries.paid,
        pigeons.id AS pigeon_id,
        pigeons.ring_no,
        pigeons.name AS pigeon_name,
        members.member_no,
        members.name AS owner
      FROM entries
      JOIN pigeons
        ON entries.pigeon_id = pigeons.id
      JOIN members
        ON pigeons.member_id = members.id
      WHERE entries.race_id = $1
      ORDER BY members.name, pigeons.ring_no
    `, [raceId]);

    res.render("race-entries", {
      user: req.session.user,
      race: raceResult.rows[0],
      pigeons: pigeonsResult.rows,
      entries: entriesResult.rows
    });

  } catch (err) {
    console.error("RACE ENTRIES ERROR:", err);
    res.status(500).send(err.message);
  }
});


/* ADD PIGEON TO RACE */
app.post("/races/:id/entries", requireLogin, async (req, res) => {

  if (req.session.user.role !== "organizer") {
    return res.status(403).send("Access denied");
  }

  try {
    const raceId = req.params.id;
    const { pigeon_id } = req.body;

    if (!pigeon_id) {
      return res.status(400).send("Please select a pigeon.");
    }

    // Check race exists
    const raceResult = await pool.query(
      "SELECT id FROM races WHERE id = $1",
      [raceId]
    );

    if (raceResult.rows.length === 0) {
      return res.status(404).send("Race not found");
    }

    // Add pigeon
    await pool.query(
      `
      INSERT INTO entries (race_id, pigeon_id)
      VALUES ($1, $2)
      `,
      [raceId, pigeon_id]
    );

    res.redirect(`/races/${raceId}/entries`);

  } catch (err) {

    console.error("ADD RACE ENTRY ERROR:", err);

    // Duplicate pigeon in same race
    if (err.code === "23505") {
      return res.status(400).send(
        "This pigeon is already entered in this race."
      );
    }

    res.status(500).send(err.message);
  }
});


/* REMOVE PIGEON FROM RACE */
app.post(
  "/races/:raceId/entries/:entryId/delete",
  requireLogin,
  async (req, res) => {

    if (req.session.user.role !== "organizer") {
      return res.status(403).send("Access denied");
    }

    try {
      const { raceId, entryId } = req.params;

      await pool.query(
        `
        DELETE FROM entries
        WHERE id = $1
        AND race_id = $2
        `,
        [entryId, raceId]
      );

      res.redirect(`/races/${raceId}/entries`);

    } catch (err) {
      console.error("REMOVE ENTRY ERROR:", err);
      res.status(500).send(err.message);
    }
  }
);
/* ================================
   CLOCKING
================================ */

/* CLOCKING PAGE */
app.get("/races/:id/clocking", requireLogin, async (req, res) => {

  if (req.session.user.role !== "organizer") {
    return res.status(403).send("Access denied");
  }

  try {

    const raceId = req.params.id;

    // Get race
    const raceResult = await pool.query(
      "SELECT * FROM races WHERE id = $1",
      [raceId]
    );

    if (raceResult.rows.length === 0) {
      return res.status(404).send("Race not found");
    }

    // Get all pigeons entered in this race
    const entriesResult = await pool.query(`
      SELECT
        entries.id AS entry_id,
        entries.paid,
        pigeons.ring_no,
        pigeons.name AS pigeon_name,
        members.member_no,
        members.name AS owner,
        clockings.arrival_time,
        clockings.verified
      FROM entries

      JOIN pigeons
        ON entries.pigeon_id = pigeons.id

      JOIN members
        ON pigeons.member_id = members.id

      LEFT JOIN clockings
        ON entries.id = clockings.entry_id

      WHERE entries.race_id = $1

      ORDER BY clockings.arrival_time ASC NULLS LAST
    `, [raceId]);

    res.render("clocking", {
      user: req.session.user,
      race: raceResult.rows[0],
      entries: entriesResult.rows
    });

  } catch (err) {

    console.error("CLOCKING ERROR:", err);

    res.status(500).send(err.message);
  }
});


/* SAVE CLOCKING */
app.post("/races/:id/clocking", requireLogin, async (req, res) => {

  if (req.session.user.role !== "organizer") {
    return res.status(403).send("Access denied");
  }

  try {

    const raceId = req.params.id;

    const {
      entry_id,
      arrival_time
    } = req.body;

    if (!entry_id || !arrival_time) {
      return res.status(400).send(
        "Entry and arrival time are required."
      );
    }

    // Make sure the entry belongs to this race
    const entryResult = await pool.query(
      `
      SELECT id
      FROM entries
      WHERE id = $1
      AND race_id = $2
      `,
      [entry_id, raceId]
    );

    if (entryResult.rows.length === 0) {
      return res.status(400).send(
        "Invalid race entry."
      );
    }

    // Check if already clocked
    const existing = await pool.query(
      `
      SELECT id
      FROM clockings
      WHERE entry_id = $1
      `,
      [entry_id]
    );

    if (existing.rows.length > 0) {

      await pool.query(
        `
        UPDATE clockings
        SET arrival_time = $1,
            verified = FALSE
        WHERE entry_id = $2
        `,
        [arrival_time, entry_id]
      );

    } else {

      await pool.query(
        `
        INSERT INTO clockings
        (
          entry_id,
          arrival_time,
          verified
        )
        VALUES($1,$2,FALSE)
        `,
        [entry_id, arrival_time]
      );

    }

    res.redirect(`/races/${raceId}/clocking`);

  } catch (err) {

    console.error("SAVE CLOCKING ERROR:", err);

    res.status(500).send(err.message);
  }
});


/* VERIFY CLOCKING */
app.post(
  "/races/:raceId/clocking/:entryId/verify",
  requireLogin,
  async (req, res) => {

    if (req.session.user.role !== "organizer") {
      return res.status(403).send("Access denied");
    }

    try {

      const { raceId, entryId } = req.params;

      await pool.query(
        `
        UPDATE clockings
        SET verified = TRUE
        WHERE entry_id = $1
        `,
        [entryId]
      );

      res.redirect(`/races/${raceId}/clocking`);

    } catch (err) {

      console.error("VERIFY CLOCKING ERROR:", err);

      res.status(500).send(err.message);
    }
  }
);

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

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
