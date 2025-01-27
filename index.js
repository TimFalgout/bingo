const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const session = require("express-session");
const bodyParser = require("body-parser");
require("dotenv").config();
const { Pool } = require("pg");
const bcrypt = require("bcrypt");

const app = express();
const server = http.createServer(app); // Create HTTP server for Socket.IO
const io = new Server(server); // Initialize Socket.IO

app.set("view engine", "ejs");
app.use(express.static("public"));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

app.use(
  session({
    secret: "bingo_secret_key",
    resave: false,
    saveUninitialized: true,
  })
);

// PostgreSQL setup
const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
});

// Helper function to sanitize table names
const sanitizeTableName = (username) => username.replace(/[^a-zA-Z0-9_]/g, "");

// Initialize all tables
const initializeTables = async () => {
  try {
    // Create the `users` table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
          id SERIAL PRIMARY KEY,
          username VARCHAR(50) UNIQUE NOT NULL,
          password VARCHAR(100) NOT NULL
      );
    `);

    // Create the `bingo_items` table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bingo_items (
          id SERIAL PRIMARY KEY,
          value VARCHAR(50) NOT NULL
      );
    `);

    // Populate the `bingo_items` table with predefined values (if not already present)
    await pool.query(`
      INSERT INTO bingo_items (value)
      SELECT unnest(ARRAY[
        'Face mask called', 'Missed fieldgoal', 'Eagles fumble', 'Chiefs fumble',
        'Eagles throw interception', 'Chiefs throw interception', 'Safety',
        'Eagles lead at halftime', 'Chiefs lead at halftime', '2pt conversion',
        'Interception to a touchdown', 'fumble to a touchdown',
        'Eagles lead at end of 1st qtr', 'Chiefs lead at end of 1st qtr',
        'Eagles lead at end of 3rd qtr', 'Chiefs lead at end of 3rd quarter',
        'Game tied at end of 4th qtr', 'Eagles win the game', 'Chiefs win the game',
        'Coaches challenge', 'Punt return for TD', 'Kickoff return for TD',
        'Successful 4th down conversion', 'Eagles quarterback sacked',
        'Chiefs quarterback sacked', 'Rushing TD', 'Passing TD', 'quarterback sneak',
        'Pass interference called', 'Offensive holding called'
      ])
      WHERE NOT EXISTS (SELECT 1 FROM bingo_items);
    `);

    console.log("All tables initialized successfully");
  } catch (err) {
    console.error("Error initializing tables:", err);
    process.exit(1);
  }
};

// Reset or create a user's bingo board
const createOrResetBingoBoard = async (username) => {
  const tableName = sanitizeTableName(username + "_bingo");

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS "${tableName}" (
          id SERIAL PRIMARY KEY,
          value VARCHAR(50) NOT NULL,
          checked BOOLEAN DEFAULT FALSE,
          position INTEGER
      );
    `);

    await pool.query(`TRUNCATE TABLE "${tableName}"`);

    const randomItems = await pool.query(`
      SELECT value 
      FROM bingo_items 
      ORDER BY RANDOM() 
      LIMIT 25
    `);

    const valuesList = randomItems.rows
      .map((_, index) => `($${index * 2 + 1}, $${index * 2 + 2})`)
      .join(", ");

    const queryParams = randomItems.rows.flatMap((item, index) => [
      item.value,
      index,
    ]);

    await pool.query(
      `
      INSERT INTO "${tableName}" (value, position)
      VALUES ${valuesList}
    `,
      queryParams
    );
  } catch (err) {
    console.error(`Error resetting bingo board for user ${username}:`, err);
    throw err;
  }
};

// Drop all dynamically created bingo boards (Admin action)
const dropAllBingoTables = async () => {
  try {
    const tables = await pool.query(`
      SELECT tablename 
      FROM pg_tables 
      WHERE schemaname = 'public' AND tablename LIKE '%_bingo';
    `);

    for (const row of tables.rows) {
      await pool.query(`DROP TABLE IF EXISTS "${row.tablename}" CASCADE`);
    }

    console.log("All bingo tables dropped successfully.");
  } catch (err) {
    console.error("Error dropping bingo tables:", err);
    throw err;
  }
};

// Routes
app.get("/", (req, res) => {
  res.render("index", { message: null });
});

app.post("/auth", async (req, res) => {
  const { username, password } = req.body;

  try {
    const userResult = await pool.query(
      "SELECT * FROM users WHERE username = $1",
      [username]
    );
    const user = userResult.rows[0];

    if (user) {
      if (await bcrypt.compare(password, user.password)) {
        req.session.username = username;
        await createOrResetBingoBoard(username);
        return res.redirect("/bingo");
      } else {
        return res.render("index", {
          message: "Incorrect password. Please try again.",
        });
      }
    } else {
      const hashedPassword = await bcrypt.hash(password, 10);
      await pool.query(
        "INSERT INTO users (username, password) VALUES ($1, $2)",
        [username, hashedPassword]
      );

      await createOrResetBingoBoard(username);

      req.session.username = username;
      return res.redirect("/bingo");
    }
  } catch (err) {
    console.error("Auth error:", err);
    res.render("index", { message: "An error occurred. Please try again." });
  }
});

app.post("/clear-database", async (req, res) => {
  const { password } = req.body;

  if (password !== "zxcvbnm") {
    return res.status(401).json({ error: "Unauthorized: Incorrect password." });
  }

  try {
    await dropAllBingoTables();
    await initializeTables();
    res.status(200).json({ success: true });
  } catch (err) {
    console.error("Failed to clear database:", err);
    res.status(500).json({ error: "Failed to clear database." });
  }
});

app.get("/bingo", async (req, res) => {
  if (!req.session.username) {
    return res.redirect("/");
  }

  try {
    const allUsers = await pool.query("SELECT username FROM users");
    const userCards = {};

    for (const user of allUsers.rows) {
      const tableName = sanitizeTableName(user.username + "_bingo");

      const bingoItems = await pool.query(`
        SELECT * FROM "${tableName}" 
        ORDER BY COALESCE(position, id)
      `);
      userCards[user.username] = bingoItems.rows;
    }

    res.render("bingo", {
      username: req.session.username,
      userCards: userCards,
      allUsers: allUsers.rows,
    });
  } catch (err) {
    console.error("Bingo page error:", err);
    res.redirect("/");
  }
});

// Socket.IO logic remains as in the previous code

// Initialize tables and start server
initializeTables()
  .then(() => {
    server.listen(3000, () => {
      console.log("Server running on port 3000");
    });
  })
  .catch((err) => {
    console.error("Failed to start server:", err);
    process.exit(1);
  });
