# Wlaaaa28

نظام ولاء عربي للكافيهات مبني بواجهة ثابتة وSupabase.

## الواجهات

- `index.html`: بطاقة العميل والمكافآت والروليت.
- `order.html`: قائمة الطلب من السيارة والسلة وتتبع الطلب.
- `cashier.html`: تسجيل الزيارات واستبدال المكافآت.
- `dashboard.html`: إعدادات المقهى والعملاء والتقارير.
- `reset-password.html`: طلب استعادة كلمة المرور وتعيين كلمة جديدة.

## الإعداد

1. انسخ `config.example.js` إلى `config.js` إذا لم يكن موجودًا.
2. ضع رابط مشروع Supabase ومفتاح `publishable` أو `anon` العام فقط.
3. لا تضع `service_role` أو أي سر في ملفات الواجهة.
4. أضف أسرار Edge Functions التالية في Supabase:
   - `CLIENT_APP_URL`: رابط الواجهة الأساسي، مثل `https://loyalty.example.com`.
   - `ALLOWED_ORIGINS`: قائمة روابط إضافية مفصولة بفواصل عند الحاجة.

روابط العملاء تستخدم رمزًا ثابتًا من 8 أحرف وأرقام، مثل
`https://loyalty.example.com/#A8B2C9D4`. تبني صفحة الكاشير الرابط من عنوانها
الحالي بعد أن يتحقق الخادم من تطابق المصدر، و`CLIENT_APP_URL` احتياطي فقط.
عند شراء دومين جديد لا تتغير رموز العملاء ولا تحتاج لإعادة إنشاء بياناتهم.

في الكاشير يبدأ التدفق برقم الجوال فقط. زر «إضافة» يجهّز العميل والرابط، ويطلب
الاسم اختياريًا إذا كان الرقم جديدًا، ثم يفتح اعتماد العملية رابط WhatsApp Web
مباشرة من نقرة الموظف دون صفحة انتظار وسيطة.

يُحفظ تخصيص صفحة العميل في `cafes.customer_theme`. يستطيع صاحب الكافيه ضبط
الخلفية والنص واللون المميز والخط لكل من الصفحة، بطاقة العضوية، رصيد الأكواب،
الروليت، المكافآت والزيارات. قيم CSS تُقبل من قائمة آمنة في الواجهة العامة.

## قاعدة البيانات وEdge Functions

```sh
supabase link --project-ref ghuiotbjwefwwguvzphe
supabase db push
supabase functions deploy customer-me --no-verify-jwt
supabase functions deploy customer-upsert --no-verify-jwt
supabase functions deploy spin --no-verify-jwt
supabase functions deploy verify-code --no-verify-jwt
supabase functions deploy customer-auth --no-verify-jwt
supabase functions deploy order-api --no-verify-jwt
```

تعطيل فحص JWT على بوابة Edge مقصود هنا: الدوال العامة تتحقق من مدخلاتها، و`customer-upsert` يتحقق من جلسة الموظف داخل الدالة. لا تغيّر هذا السلوك من دون تحديث آلية المصادقة.

## الفحص

```sh
node --experimental-vm-modules scripts/check-static.mjs
node scripts/test-edge.mjs
deno check supabase/functions/customer-me/index.ts
deno check supabase/functions/customer-upsert/index.ts
deno check supabase/functions/spin/index.ts
deno check supabase/functions/verify-code/index.ts
deno check supabase/functions/customer-auth/index.ts
deno check supabase/functions/order-api/index.ts
```

يجب تشغيل المهاجرات أولًا قبل نشر نسخة واجهة تعتمد على وظائف التحقق والروليت الذرية.
## الطلب من السيارة وواتساب

يدعم النظام قائمة منتجات وسلة وبيانات السيارة وإشعار الوصول وتتبع الحالة والدفع
عند الاستلام. يُضاف رصيد ولاء واحد لكل طلب مدفوع ومكتمل، وتُحجز مكافأة الكوب
المجاني عند إنشاء الطلب ثم تُستهلك عند التسليم أو تُحرر عند الإلغاء.

تُضاف القيم التالية في **Supabase Dashboard → Edge Functions → Secrets** فقط،
ولا يوضع رمز الوصول الدائم في المستودع:

- `META_WHATSAPP_TOKEN`: رمز وصول Meta الدائم.
- `META_PHONE_NUMBER_ID`: معرّف رقم الهاتف المرسل.
- `META_WABA_ID`: معرّف حساب واتساب للأعمال (للإدارة).
- `META_TEMPLATE_NAME`: حاليًا `alhsan_job_application_confirm`.
- `META_TEMPLATE_LANGUAGE`: حاليًا `ar`.
- `META_GRAPH_VERSION`: اختياري؛ القيمة الافتراضية `v25.0`.

يجب أن يستقبل المتغير الأول في نص القالب رمز الدخول المكوّن من ستة أرقام. لا
يحتاج هذا التدفق إلى Webhook أو استقبال الردود.
