// server.js - Main xToyStories server
// npm install express pg uuid multer sharp nodemailer node-rate-limiter-flexible jsonwebtoken bcrypt cors dotenv

import express from "express";
import pg from "pg";
import { v4 as uuidv4 } from "uuid";
import multer from "multer";
import sharp from "sharp";
import path from "path";
import fs from "fs";
import nodemailer from "nodemailer";
import { RateLimiterMemory } from "node-rate-limiter-flexible";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const db = new pg.Pool();
const uploadsDir = "./uploads/products";
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// Rate limiter
const rateLimiter = new RateLimiterMemory({ points: 5, duration: 86400, keyPrefix: "submission" });

// Email setup
const mailer = nodemailer.createTransport({
  host: process.env.MAIL_HOST,
  port: process.env.MAIL_PORT,
  secure: true,
  auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS },
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 6 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) cb(null, true);
    else cb(new Error("Only image files allowed"));
  },
});

// ---- Middleware ----
function requireAuth(req, res, next) {
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  try {
    req.userId = jwt.verify(token, process.env.JWT_SECRET).userId;
    next();
  } catch {
    res.status(401).json({ error: "authentication required" });
  }
}

function requireAdmin(req, res, next) {
  const adminToken = req.headers["x-admin-token"];
  if (adminToken !== process.env.ADMIN_TOKEN) return res.status(401).json({ error: "admin token required" });
  next();
}

// ---- Auth endpoints ----
app.post("/api/auth/signup", async (req, res) => {
  const { email, password, handle } = req.body;
  if (!email || !password || password.length < 8) return res.status(400).json({ error: "valid email and 8+ char password required" });

  try {
    const existing = await db.query(`SELECT id FROM user_accounts WHERE email = $1`, [email]);
    if (existing.rows.length) return res.status(409).json({ error: "account already exists" });

    const userId = uuidv4();
    const passwordHash = await bcrypt.hash(password, 12);
    const finalHandle = handle || `reviewer_${userId.slice(0, 8)}`;

    await db.query(
      `INSERT INTO user_accounts (id, email, password_hash, handle) VALUES ($1, $2, $3, $4)`,
      [userId, email, passwordHash, finalHandle]
    );

    const token = jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: "30d" });
    res.status(201).json({ token, userId, handle: finalHandle });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "signup failed" });
  }
});

app.post("/api/auth/signin", async (req, res) => {
  const { email, password } = req.body;
  try {
    const { rows } = await db.query(`SELECT id, password_hash, handle FROM user_accounts WHERE email = $1`, [email]);
    if (!rows.length || !(await bcrypt.compare(password, rows[0].password_hash))) {
      return res.status(401).json({ error: "invalid email or password" });
    }
    const token = jwt.sign({ userId: rows[0].id }, process.env.JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, userId: rows[0].id, handle: rows[0].handle });
  } catch (err) {
    res.status(500).json({ error: "signin failed" });
  }
});

// ---- Helper: Strip EXIF + optimize image ----
async function stripExifAndOptimize(buffer) {
  return sharp(buffer)
    .rotate()
    .withMetadata(false)
    .resize(800, 800, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: 85 })
    .toBuffer();
}

// ---- Reviews endpoint ----
app.post("/api/reviews", requireAuth, upload.array("images", 3), async (req, res) => {
  const { productName, manufacturer, price, category, rating, reviewText } = req.body;

  if (!productName || !rating || !reviewText) {
    return res.status(400).json({ error: "product name, rating, and review text required" });
  }

  try {
    const reviewId = uuidv4();
    const imagePaths = [];

    // Process images
    for (const file of req.files || []) {
      const filename = `${reviewId}-${uuidv4().slice(0, 8)}.webp`;
      const filepath = path.join(uploadsDir, filename);
      const buf = await stripExifAndOptimize(file.buffer);
      fs.writeFileSync(filepath, buf);
      imagePaths.push(`/uploads/products/${filename}`);
    }

    // Insert review
    await db.query(
      `INSERT INTO reviews (id, product_name, manufacturer, price_usd, category, rating, text, author_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [reviewId, productName, manufacturer, parseFloat(price) || 0, category || null, parseInt(rating), reviewText, req.userId, "pending"]
    );

    // Store images
    for (const imgPath of imagePaths) {
      await db.query(
        `INSERT INTO review_images (id, review_id, image_url) VALUES ($1, $2, $3)`,
        [uuidv4(), reviewId, imgPath]
      );
    }

    res.status(201).json({ id: reviewId, status: "pending", message: "Review submitted for moderation" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "review submission failed" });
  }
});

app.get("/api/reviews", async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT r.id, r.product_name, r.manufacturer, r.rating, r.text, r.created_at, ua.handle,
              array_agg(ri.image_url) as images
       FROM reviews r
       LEFT JOIN user_accounts ua ON r.author_id = ua.id
       LEFT JOIN review_images ri ON r.id = ri.review_id
       WHERE r.status = 'approved'
       GROUP BY r.id, ua.handle
       ORDER BY r.created_at DESC
       LIMIT 20`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: "failed to fetch reviews" });
  }
});

app.get("/api/reviews/:userId", requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, product_name, rating, status, created_at FROM reviews WHERE author_id = $1 ORDER BY created_at DESC`,
      [req.params.userId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: "failed to fetch reviews" });
  }
});

// ---- Content/Articles endpoint ----
app.post("/api/content", requireAuth, upload.array("images", 6), async (req, res) => {
  const { title, contentType, text } = req.body;

  if (!title || !text) {
    return res.status(400).json({ error: "title and text required" });
  }

  try {
    const contentId = uuidv4();
    const imagePaths = [];

    for (const file of req.files || []) {
      const filename = `${contentId}-${uuidv4().slice(0, 8)}.webp`;
      const filepath = path.join(uploadsDir, filename);
      const buf = await stripExifAndOptimize(file.buffer);
      fs.writeFileSync(filepath, buf);
      imagePaths.push(`/uploads/products/${filename}`);
    }

    await db.query(
      `INSERT INTO articles (id, title, content_type, text, author_id, status)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [contentId, title, contentType || "article", text, req.userId, "pending"]
    );

    for (const imgPath of imagePaths) {
      await db.query(
        `INSERT INTO article_images (id, article_id, image_url) VALUES ($1, $2, $3)`,
        [uuidv4(), contentId, imgPath]
      );
    }

    res.status(201).json({ id: contentId, status: "pending", message: "Article submitted for moderation" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "article submission failed" });
  }
});

app.get("/api/content", async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT a.id, a.title, a.content_type, a.text, a.created_at, ua.handle,
              array_agg(ai.image_url) as images
       FROM articles a
       LEFT JOIN user_accounts ua ON a.author_id = ua.id
       LEFT JOIN article_images ai ON a.id = ai.article_id
       WHERE a.status = 'approved'
       GROUP BY a.id, ua.handle
       ORDER BY a.created_at DESC
       LIMIT 20`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: "failed to fetch content" });
  }
});

app.get("/api/content/:userId", requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, title, content_type, status, created_at FROM articles WHERE author_id = $1 ORDER BY created_at DESC`,
      [req.params.userId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: "failed to fetch articles" });
  }
});

// ---- Admin moderation ----
app.get("/api/admin/moderation", requireAdmin, async (req, res) => {
  const { search, type, sort = "created_at", limit = 50 } = req.query;
  const params = [];
  let query = `SELECT id, title, text, status, created_at FROM reviews WHERE status = 'pending'`;

  if (search) {
    query += ` AND (product_name ILIKE $${params.length + 1})`;
    params.push(`%${search}%`);
  }

  query += ` ORDER BY ${sort} DESC LIMIT $${params.length + 1}`;
  params.push(parseInt(limit));

  try {
    const { rows } = await db.query(query, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: "failed to fetch pending reviews" });
  }
});

app.patch("/api/admin/moderation/:id", requireAdmin, async (req, res) => {
  const { status, notes } = req.body;
  if (!["approved", "rejected"].includes(status)) return res.status(400).json({ error: "invalid status" });

  try {
    await db.query(`UPDATE reviews SET status = $1, moderation_notes = $2 WHERE id = $3`, [status, notes || null, req.params.id]);
    res.json({ id: req.params.id, status });
  } catch (err) {
    res.status(500).json({ error: "moderation update failed" });
  }
});

app.get("/api/admin/stats", requireAdmin, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending_count,
        COUNT(CASE WHEN status = 'approved' THEN 1 END) as approved_count,
        COUNT(CASE WHEN status = 'rejected' THEN 1 END) as rejected_count
      FROM reviews
    `);
    const stats = rows[0];
    stats.approval_rate = stats.approved_count + stats.rejected_count > 0 
      ? Math.round((stats.approved_count / (stats.approved_count + stats.rejected_count)) * 100)
      : 0;
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: "failed to fetch stats" });
  }
});

// ---- Static files ----
app.use("/uploads", express.static("uploads"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`xToyStories server running on port ${PORT}`));
