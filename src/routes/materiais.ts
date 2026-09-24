import { Router, Response, NextFunction } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { ErroHttp } from "../lib/erros";
import { exigirAutenticacao, RequisicaoAutenticada } from "../middleware/auth";

// Biblioteca de apresentações. As imagens dos slides são URLs (http/https) ou data URLs
// (o front comprime a imagem antes de enviar). Para muito volume, troque por um storage
// (Supabase Storage / Vercel Blob) e grave só a URL aqui.
const router = Router();
router.use(exigirAutenticacao);

const TAMANHO_MAX_IMAGEM = 3_500_000; // ~3,5 MB por slide (limite de corpo da Vercel é 4,5 MB)

const urlImagem = z
  .string()
  .min(1)
  .max(TAMANHO_MAX_IMAGEM, "Imagem grande demais. Use até ~3 MB por slide.")
  .refine((v) => /^https?:\/\//.test(v) || /^data:image\/(png|jpe?g|webp|gif|svg\+xml);/.test(v), "Formato de imagem não suportado.");

// GET /materiais?todos=1 (gestor vê também os inativos)
router.get("/", async (req: RequisicaoAutenticada, res) => {
  const usuarioId = req.usuario!.id;
  const incluirInativos = req.usuario!.papel === "gestor" && req.query.todos === "1";

  const materiais = await prisma.material.findMany({
    where: incluirInativos ? {} : { OR: [{ ativo: true }, { criadoPorId: usuarioId }] },
    orderBy: { titulo: "asc" },
    select: {
      id: true,
      titulo: true,
      descricao: true,
      codigo: true,
      produto: true,
      thumbnailUrl: true,
      ativo: true,
      updatedAt: true,
      criadoPorId: true,
      criadoPor: { select: { nome: true } },
      _count: { select: { slides: true, registros: true } },
      favoritos: { where: { usuarioId }, select: { usuarioId: true } },
      registros: { where: { consultorId: usuarioId }, select: { inicio: true }, orderBy: { inicio: "desc" }, take: 1 },
    },
  });

  res.json({
    materiais: materiais.map((m) => ({
      id: m.id,
      titulo: m.titulo,
      descricao: m.descricao,
      codigo: m.codigo,
      produto: m.produto,
      thumbnailUrl: m.thumbnailUrl,
      ativo: m.ativo,
      atualizadoEm: m.updatedAt.toISOString(),
      totalSlides: m._count.slides,
      totalApresentacoes: m._count.registros,
      favorito: m.favoritos.length > 0,
      ultimoUsoEm: m.registros[0]?.inicio.toISOString() ?? null,
      criadoPorId: m.criadoPorId,
      criadoPorNome: m.criadoPor?.nome ?? null,
      meuMaterial: m.criadoPorId === usuarioId,
    })),
  });
});

router.get("/:id", async (req: RequisicaoAutenticada, res) => {
  const material = await prisma.material.findUnique({
    where: { id: String(req.params.id) },
    include: {
      slides: { orderBy: { ordem: "asc" } },
      favoritos: { where: { usuarioId: req.usuario!.id }, select: { usuarioId: true } },
      criadoPor: { select: { nome: true } },
    },
  });
  const podeVerInativo = req.usuario!.papel === "gestor" || material?.criadoPorId === req.usuario!.id;
  if (!material || (!material.ativo && !podeVerInativo)) throw new ErroHttp(404, "Material não encontrado.");

  const { favoritos, slides, criadoPor, ...resto } = material;
  res.json({
    material: {
      ...resto,
      criadoPorNome: criadoPor?.nome ?? null,
      meuMaterial: material.criadoPorId === req.usuario!.id,
      favorito: favoritos.length > 0,
      slides: slides.map((s) => ({ id: s.id, ordem: s.ordem, titulo: s.titulo, secao: s.secao, imagemUrl: s.imagemUrl })),
    },
  });
});

const materialSchema = z.object({
  titulo: z.string().min(1),
  descricao: z.string().optional(),
  codigo: z.string().optional(),
  produto: z.string().optional(),
  ativo: z.boolean().optional(),
  thumbnailUrl: urlImagem.nullable().optional(),
});

const vazioParaNull = (v?: string) => (v === undefined ? undefined : v.trim() || null);

// Gestor edita/exclui qualquer material. Consultor só o que ele mesmo criou.
async function exigirDonoOuGestor(req: RequisicaoAutenticada, res: Response, next: NextFunction) {
  const material = await prisma.material.findUnique({ where: { id: String(req.params.id) }, select: { criadoPorId: true } });
  if (!material) throw new ErroHttp(404, "Material não encontrado.");
  const ehDono = req.usuario!.papel === "gestor" || material.criadoPorId === req.usuario!.id;
  if (!ehDono) return res.status(403).json({ erro: "Você só pode editar materiais que você mesmo criou." });
  next();
}

router.post("/", async (req: RequisicaoAutenticada, res) => {
  const parsed = materialSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ erro: "Informe o título do material." });
  const d = parsed.data;
  const material = await prisma.material.create({
    data: {
      titulo: d.titulo.trim(),
      descricao: vazioParaNull(d.descricao),
      codigo: vazioParaNull(d.codigo),
      produto: vazioParaNull(d.produto),
      ativo: d.ativo ?? true,
      thumbnailUrl: d.thumbnailUrl ?? null,
      criadoPorId: req.usuario!.papel === "consultor" ? req.usuario!.id : null,
    },
  });
  res.status(201).json({ material });
});

router.patch("/:id", exigirDonoOuGestor, async (req, res) => {
  const parsed = materialSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ erro: parsed.error.issues[0]?.message ?? "Dados inválidos." });
  const d = parsed.data;
  const material = await prisma.material.update({
    where: { id: String(req.params.id) },
    data: {
      titulo: d.titulo?.trim(),
      descricao: vazioParaNull(d.descricao),
      codigo: vazioParaNull(d.codigo),
      produto: vazioParaNull(d.produto),
      ativo: d.ativo,
      thumbnailUrl: d.thumbnailUrl,
    },
  });
  res.json({ material });
});

router.delete("/:id", exigirDonoOuGestor, async (req, res) => {
  await prisma.material.delete({ where: { id: String(req.params.id) } });
  res.json({ ok: true });
});

const slideSchema = z.object({
  imagemUrl: urlImagem,
  // Versão pequena da imagem; usada como capa quando for o primeiro slide.
  miniaturaUrl: urlImagem.optional(),
  titulo: z.string().optional(),
  secao: z.string().optional(),
});

router.post("/:id/slides", exigirDonoOuGestor, async (req, res) => {
  const parsed = slideSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ erro: parsed.error.issues[0]?.message ?? "Imagem do slide inválida." });

  const materialId = String(req.params.id);
  const material = await prisma.material.findUnique({ where: { id: materialId }, select: { thumbnailUrl: true } });
  if (!material) throw new ErroHttp(404, "Material não encontrado.");

  const ultima = await prisma.slide.aggregate({ where: { materialId }, _max: { ordem: true } });
  const slide = await prisma.slide.create({
    data: {
      materialId,
      ordem: (ultima._max.ordem ?? 0) + 1,
      imagemUrl: parsed.data.imagemUrl,
      titulo: vazioParaNull(parsed.data.titulo),
      secao: vazioParaNull(parsed.data.secao),
    },
  });
  if (!material.thumbnailUrl) {
    await prisma.material.update({ where: { id: materialId }, data: { thumbnailUrl: parsed.data.miniaturaUrl ?? parsed.data.imagemUrl } });
  }
  res.status(201).json({ slide: { id: slide.id, ordem: slide.ordem, titulo: slide.titulo, secao: slide.secao, imagemUrl: slide.imagemUrl } });
});

router.patch("/:id/slides/:slideId", exigirDonoOuGestor, async (req, res) => {
  const parsed = z.object({ titulo: z.string().optional(), secao: z.string().optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ erro: "Dados inválidos." });
  await prisma.slide.update({
    where: { id: String(req.params.slideId), materialId: String(req.params.id) },
    data: { titulo: vazioParaNull(parsed.data.titulo), secao: vazioParaNull(parsed.data.secao) },
  });
  res.json({ ok: true });
});

// PUT /materiais/:id/slides/ordem  { ids: [slideId, ...] } na nova ordem
router.put("/:id/slides/ordem", exigirDonoOuGestor, async (req, res) => {
  const parsed = z.object({ ids: z.array(z.string()).min(1) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ erro: "Ordem inválida." });
  const materialId = String(req.params.id);
  await prisma.$transaction(parsed.data.ids.map((id, i) => prisma.slide.update({ where: { id, materialId }, data: { ordem: i + 1 } })));
  res.json({ ok: true });
});

router.delete("/:id/slides/:slideId", exigirDonoOuGestor, async (req, res) => {
  await prisma.slide.delete({ where: { id: String(req.params.slideId), materialId: String(req.params.id) } });
  res.json({ ok: true });
});

// Liga/desliga o favorito do usuário logado.
router.post("/:id/favorito", async (req: RequisicaoAutenticada, res) => {
  const chave = { usuarioId: req.usuario!.id, materialId: String(req.params.id) };
  const existente = await prisma.materialFavorito.findUnique({ where: { usuarioId_materialId: chave } });
  if (existente) {
    await prisma.materialFavorito.delete({ where: { usuarioId_materialId: chave } });
    return res.json({ favorito: false });
  }
  await prisma.materialFavorito.create({ data: chave });
  res.json({ favorito: true });
});

export default router;
