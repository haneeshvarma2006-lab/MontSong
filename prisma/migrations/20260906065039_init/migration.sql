-- CreateTable
CREATE TABLE "admin_users" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" DATETIME,
    "lastLoginAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "csrfSecret" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    "userAgent" TEXT,
    "ipHash" TEXT,
    CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "admin_users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "media_files" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "telegramChatId" TEXT NOT NULL,
    "telegramMessageId" INTEGER,
    "telegramFileId" TEXT NOT NULL,
    "telegramFileUniqueId" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "durationSec" INTEGER,
    "width" INTEGER,
    "height" INTEGER,
    "sha256" TEXT,
    "telegramFilePath" TEXT,
    "telegramFilePathFetchedAt" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'stored',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "categories" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "icon" TEXT,
    "accent" TEXT,
    "coverMediaId" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isPublished" BOOLEAN NOT NULL DEFAULT true,
    "isFeatured" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "categories_coverMediaId_fkey" FOREIGN KEY ("coverMediaId") REFERENCES "media_files" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "audio" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "artist" TEXT,
    "type" TEXT NOT NULL DEFAULT 'song',
    "description" TEXT,
    "categoryId" TEXT,
    "mediaId" TEXT NOT NULL,
    "coverMediaId" TEXT,
    "downloadCount" INTEGER NOT NULL DEFAULT 0,
    "playCount" INTEGER NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isPublished" BOOLEAN NOT NULL DEFAULT true,
    "isFeatured" BOOLEAN NOT NULL DEFAULT false,
    "publishedAt" DATETIME,
    "searchText" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "audio_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "audio_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "media_files" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "audio_coverMediaId_fkey" FOREIGN KEY ("coverMediaId") REFERENCES "media_files" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "tags" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "tags_on_audio" (
    "audioId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,

    PRIMARY KEY ("audioId", "tagId"),
    CONSTRAINT "tags_on_audio_audioId_fkey" FOREIGN KEY ("audioId") REFERENCES "audio" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "tags_on_audio_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "tags" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "download_events" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "audioId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "download_events_audioId_fkey" FOREIGN KEY ("audioId") REFERENCES "audio" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "cached_files" (
    "fileUniqueId" TEXT NOT NULL PRIMARY KEY,
    "path" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAccessedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "upload_intents" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "originalFileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "sha256" TEXT,
    "status" TEXT NOT NULL DEFAULT 'received',
    "error" TEXT,
    "telegramChatId" TEXT,
    "telegramMessageId" INTEGER,
    "telegramFileId" TEXT,
    "telegramFileUniqueId" TEXT,
    "audioId" TEXT,
    "payload" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "site_settings" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "admin_users_username_key" ON "admin_users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_tokenHash_key" ON "sessions"("tokenHash");

-- CreateIndex
CREATE INDEX "sessions_userId_idx" ON "sessions"("userId");

-- CreateIndex
CREATE INDEX "sessions_expiresAt_idx" ON "sessions"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "media_files_telegramFileUniqueId_key" ON "media_files"("telegramFileUniqueId");

-- CreateIndex
CREATE INDEX "media_files_kind_createdAt_idx" ON "media_files"("kind", "createdAt");

-- CreateIndex
CREATE INDEX "media_files_status_idx" ON "media_files"("status");

-- CreateIndex
CREATE UNIQUE INDEX "categories_slug_key" ON "categories"("slug");

-- CreateIndex
CREATE INDEX "categories_isPublished_sortOrder_idx" ON "categories"("isPublished", "sortOrder");

-- CreateIndex
CREATE INDEX "categories_sortOrder_idx" ON "categories"("sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "audio_slug_key" ON "audio"("slug");

-- CreateIndex
CREATE INDEX "audio_categoryId_sortOrder_idx" ON "audio"("categoryId", "sortOrder");

-- CreateIndex
CREATE INDEX "audio_isPublished_createdAt_idx" ON "audio"("isPublished", "createdAt");

-- CreateIndex
CREATE INDEX "audio_isPublished_downloadCount_idx" ON "audio"("isPublished", "downloadCount");

-- CreateIndex
CREATE INDEX "audio_isPublished_isFeatured_sortOrder_idx" ON "audio"("isPublished", "isFeatured", "sortOrder");

-- CreateIndex
CREATE INDEX "audio_mediaId_idx" ON "audio"("mediaId");

-- CreateIndex
CREATE UNIQUE INDEX "tags_slug_key" ON "tags"("slug");

-- CreateIndex
CREATE INDEX "tags_on_audio_tagId_idx" ON "tags_on_audio"("tagId");

-- CreateIndex
CREATE INDEX "download_events_audioId_createdAt_idx" ON "download_events"("audioId", "createdAt");

-- CreateIndex
CREATE INDEX "download_events_createdAt_idx" ON "download_events"("createdAt");

-- CreateIndex
CREATE INDEX "download_events_day_idx" ON "download_events"("day");

-- CreateIndex
CREATE INDEX "cached_files_lastAccessedAt_idx" ON "cached_files"("lastAccessedAt");

-- CreateIndex
CREATE INDEX "upload_intents_status_createdAt_idx" ON "upload_intents"("status", "createdAt");
