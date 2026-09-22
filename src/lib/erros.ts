/** Erro com status HTTP, tratado pelo middleware de erro em app.ts. */
export class ErroHttp extends Error {
  constructor(public status: number, mensagem: string, public detalhes?: unknown) {
    super(mensagem);
  }
}
