/**
 * NextAuth.js configuration — Credentials provider with env-based auth.
 * Internal system: username/password stored in environment variables.
 */
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Credentials({
      name: "Credentials",
      credentials: {
        username: { label: "Username", type: "text" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const validUser = process.env.AUTH_USER || "admin";
        const validPassword = process.env.AUTH_PASSWORD || "admin";

        if (
          credentials?.username === validUser &&
          credentials?.password === validPassword
        ) {
          return { id: "1", name: validUser, email: `${validUser}@local` };
        }
        return null;
      },
    }),
  ],
  pages: {
    signIn: "/login",
  },
  session: {
    strategy: "jwt",
  },
});
