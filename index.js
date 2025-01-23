const express = require("express");
const app = express();
const session = require("express-session");
const bodyParser = require("body-parser");
require("dotenv").config();
const { Pool } = require("pg");
const bcrypt = require("bcrypt");

app.set("view engine", "ejs");
app.use(express.static("public"));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

app.use(
  session({
    secret: "bingo_secret_key",
    resave: false,
    saveUninitialized: true,
  }),
);

// PostgreSQL setup
const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
});

// Helper function to sanitize table name
const sanitizeTableName = (username) => {
  return username.replace(/[^a-zA-Z0-9_]/g, "");
};

// Initialize all tables
const initializeTables = async () => {
  try {
    // Create users table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
          id SERIAL PRIMARY KEY,
          username VARCHAR(50) UNIQUE NOT NULL,
          password VARCHAR(100) NOT NULL
      );
    `);

    // Create bingo_items table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bingo_items (
          id SERIAL PRIMARY KEY,
          value VARCHAR(50) NOT NULL
      );
    `);

    // Populate bingo_items
    await pool.query(`
      INSERT INTO bingo_items (value)
      SELECT unnest(ARRAY[
        'Face mask called', 'Missed fieldgoal', 'Home fumbles', 'Away fumbles',
        'Home throws interception', 'Away throws interception', 'Safety',
        'Home leads at halftime', 'Away leads at halftime', '2pt conversion',
        'Interception to a touchdown', 'fumble to a touchdown',
        'Home leads at end of 1st qtr', 'Away leads at end of 1st qtr',
        'Home leads at end of 3rd qtr', 'Away leads at end of 3rd quarter',
        'Game tied at end of 4th qtr', 'Home team wins game', 'Away team wins game',
        'Coaches challenge', 'Punt return for TD', 'Kickoff return for TD',
        'Successful 4th down conversion', 'Home quarterback sacked',
        'Away quarterback sacked', 'Rushing TD', 'Passing TD', 'quarterback sneak',
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

// Helper function to ensure position column exists
const ensurePositionColumn = async (tableName) => {
  try {
    await pool.query(`
      SELECT position FROM "${tableName}" LIMIT 1
    `);
    return true;
  } catch (err) {
    // Position column doesn't exist, add it
    await pool.query(`
      ALTER TABLE "${tableName}"
      ADD COLUMN position INTEGER
    `);
    // Initialize positions based on current order
    await pool.query(`
      WITH numbered_rows AS (
        SELECT id, ROW_NUMBER() OVER (ORDER BY id) - 1 as row_num
        FROM "${tableName}"
      )
      UPDATE "${tableName}" t
      SET position = nr.row_num
      FROM numbered_rows nr
      WHERE t.id = nr.id
    `);
    return true;
  }
};

const checkForBingo = async (username) => {
  const tableName = sanitizeTableName(username + "_bingo");

  // Get the current board state with positions
  const result = await pool.query(`
    SELECT checked, position 
    FROM "${tableName}" 
    ORDER BY position
  `);

  const board = result.rows;
  const size = 5; // 5x5 grid

  // Convert to 2D array for easier checking
  const grid = Array(size)
    .fill()
    .map(() => Array(size).fill(false));
  board.forEach((cell, index) => {
    const row = Math.floor(index / size);
    const col = index % size;
    grid[row][col] = cell.checked;
  });

  // Check rows
  for (let row = 0; row < size; row++) {
    if (grid[row].every((cell) => cell)) return true;
  }

  // Check columns
  for (let col = 0; col < size; col++) {
    if (grid.every((row) => row[col])) return true;
  }

  // Check diagonals
  const diagonal1 = Array(size)
    .fill()
    .every((_, i) => grid[i][i]);
  const diagonal2 = Array(size)
    .fill()
    .every((_, i) => grid[i][size - 1 - i]);

  return diagonal1 || diagonal2;
};

// Helper function to create or reset user's bingo board
const createOrResetBingoBoard = async (username) => {
  const tableName = sanitizeTableName(username + "_bingo");

  try {
    // Create the table if it doesn't exist
    await pool.query(`
      CREATE TABLE IF NOT EXISTS "${tableName}" (
          id SERIAL PRIMARY KEY,
          value VARCHAR(50) NOT NULL,
          checked BOOLEAN DEFAULT FALSE
      )
    `);

    // Check if position column exists, if not add it
    try {
      await pool.query(`
        SELECT position FROM "${tableName}" LIMIT 1
      `);
    } catch (err) {
      // Position column doesn't exist, add it
      await pool.query(`
        ALTER TABLE "${tableName}"
        ADD COLUMN position INTEGER
      `);
    }

    // Clear existing entries if any
    await pool.query(`TRUNCATE TABLE "${tableName}"`);

    // Get random items for the bingo board
    const randomItems = await pool.query(`
      SELECT value 
      FROM bingo_items 
      ORDER BY RANDOM() 
      LIMIT 25
    `);

    if (randomItems.rows.length === 0) {
      throw new Error("No bingo items available");
    }

    // Insert items with positions
    const valuesList = randomItems.rows
      .map((_, index) => `($${index * 2 + 1}, $${index * 2 + 2})`)
      .join(", ");

    const queryParams = randomItems.rows.flatMap((item, index) => [
      item.value, // The actual bingo item value
      index, // Position
    ]);

    await pool.query(
      `
      INSERT INTO "${tableName}" (value, position)
      VALUES ${valuesList}
    `,
      queryParams,
    );
    return true;
  } catch (err) {
    console.error("Error creating bingo board:", err);
    throw err;
  }
};

// Routes
app.get("/", (req, res) => {
  res.render("index", { message: null });
});

// Unified Signup/Login Handler
app.post("/auth", async (req, res) => {
  const { username, password } = req.body;

  try {
    // Check if the user exists
    const userResult = await pool.query(
      "SELECT * FROM users WHERE username = $1",
      [username],
    );
    const user = userResult.rows[0];

    if (user) {
      // User exists, validate password
      if (await bcrypt.compare(password, user.password)) {
        req.session.username = username;
        // Reset bingo board on login
        await createOrResetBingoBoard(username);
        return res.redirect("/bingo");
      } else {
        return res.render("index", {
          message: "Incorrect password. Please try again.",
        });
      }
    } else {
      // User doesn't exist, create a new user
      const hashedPassword = await bcrypt.hash(password, 10);
      await pool.query(
        "INSERT INTO users (username, password) VALUES ($1, $2)",
        [username, hashedPassword],
      );

      // Create new bingo board for user
      await createOrResetBingoBoard(username);

      req.session.username = username;
      return res.redirect("/bingo");
    }
  } catch (err) {
    console.error("Auth error:", err);
    res.render("index", { message: "An error occurred. Please try again." });
  }
});

// Bingo Page
app.get("/bingo", async (req, res) => {
  if (!req.session.username) {
    return res.redirect("/");
  }

  try {
    const allUsers = await pool.query("SELECT username FROM users");
    const userCards = {};

    // Fetch bingo cards for all users
    for (const user of allUsers.rows) {
      const tableName = sanitizeTableName(user.username + "_bingo");
      await ensurePositionColumn(tableName);

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

// Mark cell as clicked
app.post("/bingo/click", async (req, res) => {
  if (!req.session.username) {
    return res.redirect("/");
  }

  const { id } = req.body;

  try {
    const tableName = sanitizeTableName(req.session.username + "_bingo");
    await ensurePositionColumn(tableName);

    // Update the cell's checked state
    await pool.query(
      `UPDATE "${tableName}" SET checked = NOT checked WHERE id = $1`,
      [id],
    );

    // Check for bingo
    const hasBingo = await checkForBingo(req.session.username);

    // Get the updated bingo board state
    const bingoItems = await pool.query(
      `SELECT * FROM "${tableName}" ORDER BY COALESCE(position, id)`,
    );

    if (req.headers.accept === "application/json") {
      // If it's an AJAX request, send JSON response
      res.json({
        success: true,
        bingoItems: bingoItems.rows,
        hasBingo: hasBingo,
        username: req.session.username,
      });
    } else {
      // If it's a regular form submission, redirect
      res.redirect("/bingo");
    }
  } catch (err) {
    console.error("Cell click error:", err);
    if (req.headers.accept === "application/json") {
      res.status(500).json({ error: "Failed to update cell" });
    } else {
      res.redirect("/bingo");
    }
  }
});

// Add a new route to reset the bingo board
app.post("/bingo/reset", async (req, res) => {
  if (!req.session.username) {
    return res.redirect("/");
  }

  try {
    await createOrResetBingoBoard(req.session.username);
    res.redirect("/bingo");
  } catch (err) {
    console.error("Reset board error:", err);
    res.redirect("/bingo");
  }
});

// Logout
app.post("/logout", (req, res) => {
  req.session.destroy();
  res.redirect("/");
});

// Table Reset For New Season or Game
app.post("/clear-database", async (req, res) => {
  const { password } = req.body;

  // Check if the provided password matches the hardcoded one
  if (password !== "zxcvbnm") {
    return res.status(401).send("Unauthorized: Incorrect password.");
  }

  try {
    // Query to fetch all table names
    const tables = await pool.query(`
      SELECT tablename FROM pg_tables 
      WHERE schemaname = 'public'
    `);

    for (const row of tables.rows) {
      const tableName = row.tablename;
      await pool.query(`DROP TABLE IF EXISTS "${tableName}" CASCADE`);
      console.log(`Dropped table: ${tableName}`);
    }

    console.log("All tables dropped successfully.");

    // Re-initialize tables after deletion
    await initializeTables();
    console.log("Tables reinitialized successfully.");

    res.redirect("/"); // Redirect back to home or confirmation page
  } catch (err) {
    console.error("Error clearing database:", err);
    res.status(500).send("Failed to clear database.");
  }
});

// Error handler middleware
app.use((err, req, res, next) => {
  console.error("Application error:", err);
  res.status(500).render("index", { message: "An unexpected error occurred." });
});

// Initialize tables before starting the server
initializeTables()
  .then(() => {
    app.listen(3000, () => {
      console.log("Server running on port 3000");
    });
  })
  .catch((err) => {
    console.error("Failed to start server:", err);
    process.exit(1);
  });
