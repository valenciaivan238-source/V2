import bcrypt from "bcryptjs";
import { randomInt } from "crypto";
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
await pool.query(`
  ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_role_check
`);

await pool.query(`
  ALTER TABLE users
  ADD CONSTRAINT users_role_check
  CHECK (role IN ('admin', 'organizer', 'member'))
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
    user: req.session.user,
    members: result.rows
  });
});
/* DELETE MEMBER / LOFT / PIGEONS / ACCOUNT */

app.post("/members/:id/delete", requireLogin, async (req, res) => {

  if (
  req.session.user.role !== "organizer" &&
  req.session.user.role !== "admin"
) {
  return res.status(403).send("Access denied");
  }

  const memberId = req.params.id;

  const client = await pool.connect();

  try {

    await client.query("BEGIN");

    // Delete clockings for this member's pigeon entries
    await client.query(`
      DELETE FROM clockings
      WHERE entry_id IN (
        SELECT entries.id
        FROM entries
        JOIN pigeons
          ON pigeons.id = entries.pigeon_id
        WHERE pigeons.member_id = $1
      )
    `, [memberId]);

    // Delete race entries for this member's pigeons
    await client.query(`
      DELETE FROM entries
      WHERE pigeon_id IN (
        SELECT id
        FROM pigeons
        WHERE member_id = $1
      )
    `, [memberId]);

    // Delete pigeons
    await client.query(`
      DELETE FROM pigeons
      WHERE member_id = $1
    `, [memberId]);

    // Delete member's login account
    await client.query(`
      DELETE FROM users
      WHERE member_id = $1
    `, [memberId]);

    // Delete member / loft
    await client.query(`
      DELETE FROM members
      WHERE id = $1
    `, [memberId]);

    await client.query("COMMIT");

    res.redirect("/members");

  } catch (err) {

    await client.query("ROLLBACK");

    console.error("DELETE MEMBER ERROR:", err);

    res.status(500).send(err.message);

  } finally {

    client.release();

  }
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
        release_latitude,
        release_longitude,
        distance_km,
        race_date,
        release_time,
        entry_fee,
        status
      )
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      `,
      [
        name,
        category,
        release_point,
        release_latitude,
        release_longitude,
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
  try {

    const result = await pool.query(`
      SELECT
        races.id AS race_id,
        races.name AS race_name,
        races.release_latitude,
        races.release_longitude,
        races.release_time,

        entries.id AS entry_id,

        pigeons.ring_no,
        pigeons.name AS pigeon_name,

        members.name AS owner,
        members.latitude AS loft_latitude,
        members.longitude AS loft_longitude,

        clockings.arrival_time,
        clockings.verified

      FROM entries

      JOIN races
        ON races.id = entries.race_id

      JOIN pigeons
        ON pigeons.id = entries.pigeon_id

      JOIN members
        ON members.id = pigeons.member_id

      LEFT JOIN clockings
        ON clockings.entry_id = entries.id

      WHERE clockings.verified = TRUE

      ORDER BY races.id DESC
    `);

    const results = result.rows.map(row => {

      let distance_km = null;
      let flight_minutes = null;
      let speed_mpm = null;

      // Make sure all coordinates and times exist
      if (
        row.release_latitude !== null &&
        row.release_longitude !== null &&
        row.loft_latitude !== null &&
        row.loft_longitude !== null &&
        row.release_time &&
        row.arrival_time
      ) {

        const R = 6371; // Earth radius in kilometers

        const lat1 =
          Number(row.release_latitude) * Math.PI / 180;

        const lat2 =
          Number(row.loft_latitude) * Math.PI / 180;

        const dLat =
          (Number(row.loft_latitude) -
            Number(row.release_latitude)) *
          Math.PI / 180;

        const dLon =
          (Number(row.loft_longitude) -
            Number(row.release_longitude)) *
          Math.PI / 180;

        const a =
          Math.sin(dLat / 2) *
          Math.sin(dLat / 2) +

          Math.cos(lat1) *
          Math.cos(lat2) *

          Math.sin(dLon / 2) *
          Math.sin(dLon / 2);

        const c =
          2 * Math.atan2(
            Math.sqrt(a),
            Math.sqrt(1 - a)
          );

        distance_km = R * c;


        // Convert PostgreSQL TIME values to seconds
        const releaseParts =
          String(row.release_time)
            .split(":")
            .map(Number);

        const arrivalParts =
          String(row.arrival_time)
            .split(":")
            .map(Number);

        const releaseSeconds =
          releaseParts[0] * 3600 +
          releaseParts[1] * 60 +
          releaseParts[2];

        const arrivalSeconds =
          arrivalParts[0] * 3600 +
          arrivalParts[1] * 60 +
          arrivalParts[2];


        // Calculate flight time
        let flightSeconds =
          arrivalSeconds - releaseSeconds;

        // Handle arrival after midnight
        if (flightSeconds < 0) {
          flightSeconds += 24 * 60 * 60;
        }

        flight_minutes =
          flightSeconds / 60;


        // Calculate meters per minute
        if (flight_minutes > 0) {

          const distanceMeters =
            distance_km * 1000;

          speed_mpm =
            distanceMeters / flight_minutes;

        }
      }

      return {
        ...row,

        distance_km:
          distance_km !== null
            ? distance_km.toFixed(3)
            : null,

        flight_minutes:
          flight_minutes !== null
            ? flight_minutes.toFixed(2)
            : null,

        speed_mpm:
          speed_mpm !== null
            ? speed_mpm.toFixed(2)
            : null
      };

    });


    // Rank by fastest m/min
    results.sort((a, b) => {

      if (a.speed_mpm === null) return 1;
      if (b.speed_mpm === null) return -1;

      return Number(b.speed_mpm) -
             Number(a.speed_mpm);

    });


    // Add ranking
    results.forEach((result, index) => {
      result.rank = index + 1;
    });


    res.render("results", {
      results
    });

  } catch (err) {

    console.error("RESULTS ERROR:", err);

    res.status(500).send(err.message);

  }
});

app.get("/admin/create-member", requireLogin, async (req, res) => {
  if (req.session.user.role !== "organizer") {
    return res.send("Access denied");
  }

  try {
    const result = await pool.query(
      "SELECT id, member_no, name FROM members ORDER BY name"
    );

    res.render("create-member", {
      members: result.rows
    });

  } catch (err) {
    console.error("LOAD MEMBERS ERROR:", err);
    res.status(500).send(err.message);
  }
});

app.post("/admin/create-member", requireLogin, async (req, res) => {
  if (req.session.user.role !== "organizer") {
    return res.status(403).send("Access denied");
  }

  try {
    const {
      username,
      password,
      member_id
    } = req.body;

    if (!username || !password || !member_id) {
      return res.status(400).send(
        "Username, password, and member are required."
      );
    }

    const hash = await bcrypt.hash(password, 10);

    await pool.query(
      `
      INSERT INTO users
      (
        username,
        password_hash,
        role,
        member_id
      )
      VALUES($1, $2, 'member', $3)
      `,
      [username, hash, member_id]
    );

    res.send("Member account created successfully");

  } catch (err) {
    console.error("CREATE MEMBER ACCOUNT ERROR:", err);

    if (err.code === "23505") {
      return res.status(400).send(
        "Username already exists."
      );
    }

    res.status(500).send(err.message);
  }
});
/* MEMBER RACE LIST */

app.get("/member/races", requireLogin, async (req, res) => {

  if (req.session.user.role !== "member") {
    return res.status(403).send("Access denied");
  }

  try {

    const userId = req.session.user.id;

    // Find the member linked to this account
    const userResult = await pool.query(
      `
      SELECT member_id
      FROM users
      WHERE id = $1
      `,
      [userId]
    );

    if (
      userResult.rows.length === 0 ||
      !userResult.rows[0].member_id
    ) {
      return res.status(400).send(
        "Member account is not linked to a member."
      );
    }

    const memberId = userResult.rows[0].member_id;

    // Get races where this member has pigeons entered
    const racesResult = await pool.query(
      `
      SELECT DISTINCT
        races.id,
        races.name,
        races.category,
        races.race_date,
        races.release_time,
        races.status
      FROM races

      JOIN entries
        ON entries.race_id = races.id

      JOIN pigeons
        ON pigeons.id = entries.pigeon_id

      WHERE pigeons.member_id = $1

      ORDER BY races.race_date DESC, races.id DESC
      `,
      [memberId]
    );

    res.render("member-races", {
      user: req.session.user,
      races: racesResult.rows
    });

  } catch (err) {

    console.error("MEMBER RACES ERROR:", err);

    res.status(500).send(err.message);
  }
});

/* =================================
   MEMBER SUBMIT ARRIVAL
================================= */

app.get("/member/races/:raceId/arrival", requireLogin, async (req, res) => {
  if (req.session.user.role !== "member") {
    return res.status(403).send("Access denied");
  }

  try {
    const raceId = req.params.raceId;
    const userId = req.session.user.id;

    // Find the member account
    const userResult = await pool.query(
      `
      SELECT member_id
      FROM users
      WHERE id = $1
      `,
      [userId]
    );

    if (
      userResult.rows.length === 0 ||
      !userResult.rows[0].member_id
    ) {
      return res.status(400).send("Member account is not linked to a member.");
    }

    const memberId = userResult.rows[0].member_id;

    // Get race
    const raceResult = await pool.query(
      `
      SELECT *
      FROM races
      WHERE id = $1
      `,
      [raceId]
    );

    if (raceResult.rows.length === 0) {
      return res.status(404).send("Race not found");
    }

    // Get this member's pigeons entered in this race
    const entriesResult = await pool.query(
      `
      SELECT
        entries.id AS entry_id,
        pigeons.ring_no,
        pigeons.name AS pigeon_name,
        clockings.arrival_time,
        clockings.verified
      FROM entries

      JOIN pigeons
        ON pigeons.id = entries.pigeon_id

      LEFT JOIN clockings
        ON clockings.entry_id = entries.id

      WHERE entries.race_id = $1
      AND pigeons.member_id = $2

      ORDER BY pigeons.ring_no
      `,
      [raceId, memberId]
    );

    res.render("member-arrival", {
      race: raceResult.rows[0],
      entries: entriesResult.rows
    });

  } catch (err) {
    console.error("MEMBER ARRIVAL PAGE ERROR:", err);
    res.status(500).send(err.message);
  }
});


/* MEMBER SUBMITS ARRIVAL */

app.post("/member/races/:raceId/arrival", requireLogin, async (req, res) => {
  if (req.session.user.role !== "member") {
    return res.status(403).send("Access denied");
  }

  try {
    const raceId = req.params.raceId;
    const userId = req.session.user.id;

    const {
      entry_id,
      verification_code,
      arrival_time
    } = req.body;

    if (!entry_id || !verification_code || !arrival_time) {
      return res.status(400).send(
        "Pigeon, verification code, and arrival time are required."
      );
    }

    // Get member linked to this account
    const userResult = await pool.query(
      `
      SELECT member_id
      FROM users
      WHERE id = $1
      `,
      [userId]
    );

    if (
      userResult.rows.length === 0 ||
      !userResult.rows[0].member_id
    ) {
      return res.status(400).send("Member account is not linked to a member.");
    }

    const memberId = userResult.rows[0].member_id;

    // Verify that this entry belongs to this member and race
    const entryResult = await pool.query(
      `
      SELECT
        entries.id,
        entries.verification_code,
        pigeons.ring_no
      FROM entries

      JOIN pigeons
        ON pigeons.id = entries.pigeon_id

      WHERE entries.id = $1
      AND entries.race_id = $2
      AND pigeons.member_id = $3
      `,
      [entry_id, raceId, memberId]
    );

    if (entryResult.rows.length === 0) {
      return res.status(403).send("Invalid race entry.");
    }

    const entry = entryResult.rows[0];

    // Check the organizer-created 5 digit code
    if (
      String(entry.verification_code).trim() !==
      String(verification_code).trim()
    ) {
      return res.status(400).send(
        "Incorrect verification code."
      );
    }

    // Check if already submitted
    const existing = await pool.query(
      `
      SELECT id
      FROM clockings
      WHERE entry_id = $1
      `,
      [entry_id]
    );

    if (existing.rows.length > 0) {
      return res.status(400).send(
        "Arrival time has already been submitted for this pigeon."
      );
    }

    // Save arrival time
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

    res.send(`
      <h2>Arrival Submitted Successfully</h2>
      <p>Pigeon Ring No: ${entry.ring_no}</p>
      <p>Your arrival time was submitted successfully.</p>
      <a href="/member/races/${raceId}/arrival">
        Back to Race
      </a>
    `);

  } catch (err) {
    console.error("MEMBER ARRIVAL ERROR:", err);
    res.status(500).send(err.message);
  }
});
/* =================================
   ADMIN / ORGANIZER DELETE FUNCTIONS
================================= */

function requireAdminOrOrganizer(req, res, next) {
  if (
    !req.session.user ||
    (
      req.session.user.role !== "admin" &&
      req.session.user.role !== "organizer"
    )
  ) {
    return res.status(403).send("Access denied");
  }

  next();
}


/* =================================
   DELETE RACE
   Deletes:
   - Clockings
   - Entries
   - Race
================================= */

app.post(
  "/admin/races/:id/delete",
  requireLogin,
  requireAdminOrOrganizer,
  async (req, res) => {

    const client = await pool.connect();

    try {
      const raceId = req.params.id;

      await client.query("BEGIN");

      // Delete clockings belonging to this race
      await client.query(
        `
        DELETE FROM clockings
        WHERE entry_id IN (
          SELECT id
          FROM entries
          WHERE race_id = $1
        )
        `,
        [raceId]
      );

      // Delete race entries
      await client.query(
        `
        DELETE FROM entries
        WHERE race_id = $1
        `,
        [raceId]
      );

      // Delete race
      const result = await client.query(
        `
        DELETE FROM races
        WHERE id = $1
        RETURNING id
        `,
        [raceId]
      );

      if (result.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).send("Race not found");
      }

      await client.query("COMMIT");

      res.redirect("/races");

    } catch (err) {

      await client.query("ROLLBACK");

      console.error("DELETE RACE ERROR:", err);

      res.status(500).send(err.message);

    } finally {

      client.release();

    }
  }
);


/* =================================
   DELETE MEMBER ACCOUNT
================================= */

app.post(
  "/admin/member-accounts/:id/delete",
  requireLogin,
  requireAdminOrOrganizer,
  async (req, res) => {

    try {

      const accountId = req.params.id;

      // Never allow the admin account to be deleted
      const account = await pool.query(
        `
        SELECT id, username, role
        FROM users
        WHERE id = $1
        `,
        [accountId]
      );

      if (account.rows.length === 0) {
        return res.status(404).send("Member account not found");
      }

      if (account.rows[0].role !== "member") {
        return res.status(400).send(
          "Only member accounts can be deleted."
        );
      }

      await pool.query(
        `
        DELETE FROM users
        WHERE id = $1
        AND role = 'member'
        `,
        [accountId]
      );

      res.redirect("/admin/create-member");

    } catch (err) {

      console.error("DELETE MEMBER ACCOUNT ERROR:", err);

      res.status(500).send(err.message);

    }
  }
);


/* =================================
   DELETE MEMBER / LOFT
   Deletes:
   - Member account linked to member
   - Clockings
   - Entries
   - Pigeons
   - Member / Loft
================================= */

app.post(
  "/admin/members/:id/delete",
  requireLogin,
  requireAdminOrOrganizer,
  async (req, res) => {

    const client = await pool.connect();

    try {

      const memberId = req.params.id;

      await client.query("BEGIN");

      // Check member exists
      const memberResult = await client.query(
        `
        SELECT id
        FROM members
        WHERE id = $1
        `,
        [memberId]
      );

      if (memberResult.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).send("Member not found");
      }

      /*
        Delete clockings for this member's race entries
      */
      await client.query(
        `
        DELETE FROM clockings
        WHERE entry_id IN (
          SELECT entries.id
          FROM entries
          JOIN pigeons
            ON pigeons.id = entries.pigeon_id
          WHERE pigeons.member_id = $1
        )
        `,
        [memberId]
      );

      /*
        Delete race entries for this member's pigeons
      */
      await client.query(
        `
        DELETE FROM entries
        WHERE pigeon_id IN (
          SELECT id
          FROM pigeons
          WHERE member_id = $1
        )
        `,
        [memberId]
      );

      /*
        Delete pigeons belonging to member
      */
      await client.query(
        `
        DELETE FROM pigeons
        WHERE member_id = $1
        `,
        [memberId]
      );

      /*
        Delete the login account linked to this member
      */
      await client.query(
        `
        DELETE FROM users
        WHERE member_id = $1
        AND role = 'member'
        `,
        [memberId]
      );

      /*
        Delete member / loft
      */
      await client.query(
        `
        DELETE FROM members
        WHERE id = $1
        `,
        [memberId]
      );

      await client.query("COMMIT");

      res.redirect("/members");

    } catch (err) {

      await client.query("ROLLBACK");

      console.error("DELETE MEMBER ERROR:", err);

      res.status(500).send(err.message);

    } finally {

      client.release();

    }
  }
);


/* =================================
   DELETE PIGEON
   Deletes:
   - Clockings
   - Race entries
   - Pigeon
================================= */

app.post(
  "/admin/pigeons/:id/delete",
  requireLogin,
  requireAdminOrOrganizer,
  async (req, res) => {

    const client = await pool.connect();

    try {

      const pigeonId = req.params.id;

      await client.query("BEGIN");

      // Check pigeon exists
      const pigeonResult = await client.query(
        `
        SELECT id
        FROM pigeons
        WHERE id = $1
        `,
        [pigeonId]
      );

      if (pigeonResult.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).send("Pigeon not found");
      }

      /*
        Delete clockings belonging to pigeon entries
      */
      await client.query(
        `
        DELETE FROM clockings
        WHERE entry_id IN (
          SELECT id
          FROM entries
          WHERE pigeon_id = $1
        )
        `,
        [pigeonId]
      );

      /*
        Delete race entries
      */
      await client.query(
        `
        DELETE FROM entries
        WHERE pigeon_id = $1
        `,
        [pigeonId]
      );

      /*
        Delete pigeon
      */
      await client.query(
        `
        DELETE FROM pigeons
        WHERE id = $1
        `,
        [pigeonId]
      );

      await client.query("COMMIT");

      res.redirect("/pigeons");

    } catch (err) {

      await client.query("ROLLBACK");

      console.error("DELETE PIGEON ERROR:", err);

      res.status(500).send(err.message);

    } finally {

      client.release();

    }
  }
);
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
