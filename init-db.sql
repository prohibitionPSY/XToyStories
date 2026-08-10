-- init-db.sql
-- Run this once: psql -U postgres -f init-db.sql

CREATE DATABASE xtoystories;

\c xtoystories

-- User accounts
CREATE TABLE user_accounts (
  id UUID PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  handle VARCHAR(100) UNIQUE,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Reviews
CREATE TABLE reviews (
  id UUID PRIMARY KEY,
  product_name VARCHAR(255) NOT NULL,
  manufacturer VARCHAR(255),
  price_usd NUMERIC(10,2),
  category VARCHAR(100),
  rating INTEGER CHECK (rating >= 1 AND rating <= 5),
  text TEXT NOT NULL,
  author_id UUID REFERENCES user_accounts(id),
  status VARCHAR(16) DEFAULT 'pending',
  moderation_notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  moderated_at TIMESTAMPTZ
);

CREATE TABLE review_images (
  id UUID PRIMARY KEY,
  review_id UUID REFERENCES reviews(id),
  image_url VARCHAR(511),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Articles
CREATE TABLE articles (
  id UUID PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  content_type VARCHAR(50),
  text TEXT NOT NULL,
  author_id UUID REFERENCES user_accounts(id),
  status VARCHAR(16) DEFAULT 'pending',
  moderation_notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  moderated_at TIMESTAMPTZ
);

CREATE TABLE article_images (
  id UUID PRIMARY KEY,
  article_id UUID REFERENCES articles(id),
  image_url VARCHAR(511),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Categories
CREATE TABLE categories (
  id UUID PRIMARY KEY,
  slug VARCHAR(100) UNIQUE,
  name VARCHAR(100)
);

INSERT INTO categories (id, slug, name) VALUES
  (gen_random_uuid(), 'for-her', 'For Her'),
  (gen_random_uuid(), 'for-him', 'For Him'),
  (gen_random_uuid(), 'couples', 'Couples'),
  (gen_random_uuid(), 'anal', 'Anal'),
  (gen_random_uuid(), 'g-spot', 'G-Spot'),
  (gen_random_uuid(), 'vibrators', 'Vibrators'),
  (gen_random_uuid(), 'dildos', 'Dildos');

CREATE INDEX idx_reviews_status ON reviews(status);
CREATE INDEX idx_reviews_author ON reviews(author_id);
CREATE INDEX idx_articles_status ON articles(status);
CREATE INDEX idx_articles_author ON articles(author_id);
